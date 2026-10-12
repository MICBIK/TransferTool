import { asNumber, asRecord, getJson, requestJson, safeMessage, UpstreamRequestError, type JsonResponse } from './http.js';
import type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, FetchContext } from './types.js';

export const DEFAULT_QUOTA_PER_UNIT = 500_000;
export const QUOTA_PER_UNIT_TTL_MS = 24 * 3600 * 1000;
export const USER_ID_REQUIRED_MESSAGE = '该站点需要用户 ID：在上游配置里填写该站的登录账号和密码，即可自动获取';
export const LEGACY_RETIRED_MESSAGE = '旧版访问令牌已失效，请到上游重新生成';

const FAIL = (error: string): BalanceResult => ({ ok: false, mode: 'newapi', error });

/** 响应里是否带有“旧版令牌已停用”的错误码（可能在 code 或 message 字段，HTTP 状态不定）。 */
function isLegacyRetired(res: JsonResponse): boolean {
  const body = asRecord(res.body);
  if (!body) return false;
  const needle = 'ACCESS_TOKEN_LEGACY_RETIRED';
  return [body.code, body.message, asRecord(body.error)?.code, asRecord(body.error)?.message].some((v) => typeof v === 'string' && v.includes(needle));
}

export function createNewApiAdapter(deps: AdapterDeps): Adapter {
  const quotaCache = new Map<string, { value: number; expiresAt: number }>();

  /** quota_per_unit 按站点缓存 24 小时；取不到时用默认值（失败结果不缓存，下次再试）。 */
  async function quotaPerUnit(site: string, ctx: FetchContext | undefined): Promise<number> {
    const hit = quotaCache.get(site);
    if (hit && hit.expiresAt > deps.clock()) return hit.value;
    try {
      const res = await getJson(deps.fetch, `${site}/api/status`, { timeoutMs: deps.timeoutMs, signal: ctx?.signal });
      const value = asNumber(asRecord(asRecord(res.body)?.data)?.quota_per_unit);
      if (res.status === 200 && value !== undefined && value > 0) {
        quotaCache.set(site, { value, expiresAt: deps.clock() + QUOTA_PER_UNIT_TTL_MS });
        return value;
      }
    } catch (err) {
      if (err instanceof UpstreamRequestError && err.kind === 'aborted') throw err;
    }
    return DEFAULT_QUOTA_PER_UNIT;
  }

  function headers(upstream: AdapterUpstream, authorization: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: authorization };
    if (upstream.userId) h['New-Api-User'] = upstream.userId;
    return h;
  }

  /**
   * 用登录账号密码换取用户 ID（new-api 的 /api/user/login 在 data.id 里返回）。
   * 只发往该上游自己的站点；失败时返回给站长看的原因。
   */
  async function loginForUserId(upstream: AdapterUpstream, ctx: FetchContext | undefined, secrets: string[]): Promise<{ id: string } | { error: string }> {
    const res = await requestJson(deps.fetch, `${upstream.siteUrl}/api/user/login`, {
      method: 'POST',
      body: { username: upstream.account, password: upstream.password },
      timeoutMs: deps.timeoutMs,
      signal: ctx?.signal,
    });
    const body = asRecord(res.body);
    const data = asRecord(body?.data);
    const id = asNumber(data?.id);
    if (res.status === 200 && body?.success === true && id !== undefined && id > 0) return { id: String(Math.trunc(id)) };
    if (data?.require_2fa === true) return { error: '该站点账号开启了两步验证，无法自动获取用户 ID，请在“高级”里手动填写' };
    const msg = safeMessage(body?.message, secrets);
    return { error: `用登录账号自动获取用户 ID 失败${msg ? `：${msg}` : `（HTTP ${res.status}）`}，请检查账号密码，或在“高级”里手动填写` };
  }

  async function querySelf(upstream: AdapterUpstream, ctx: FetchContext | undefined): Promise<JsonResponse> {
    const url = `${upstream.siteUrl}/api/user/self`;
    const opts = { timeoutMs: deps.timeoutMs, signal: ctx?.signal };
    const res = await getJson(deps.fetch, url, { ...opts, headers: headers(upstream, `Bearer ${upstream.credential}`) });
    if (res.status !== 401 && res.status !== 403) return res;
    // 旧版 new-api：Authorization 直接放令牌（不带 Bearer）
    return getJson(deps.fetch, url, { ...opts, headers: headers(upstream, upstream.credential) });
  }

  return {
    async fetchBalance(upstream, ctx) {
      const secrets = [upstream.credential, upstream.password ?? ''].filter(Boolean);
      try {
        let res = await querySelf(upstream, ctx);
        let discoveredUserId: string | undefined;

        // 新版 new-api 要求 New-Api-User 头：没填用户 ID 时用登录账号密码自动获取一次
        const needsUserId = (r: JsonResponse) => (r.status === 401 || r.status === 403) && /new-api-user/i.test(safeMessage(asRecord(r.body)?.message, secrets));
        if (!upstream.userId && needsUserId(res)) {
          if (!upstream.account || !upstream.password) return FAIL(USER_ID_REQUIRED_MESSAGE);
          const login = await loginForUserId(upstream, ctx, secrets);
          if ('error' in login) return FAIL(login.error);
          discoveredUserId = login.id;
          res = await querySelf({ ...upstream, userId: login.id }, ctx);
        }

        if (isLegacyRetired(res)) return FAIL(LEGACY_RETIRED_MESSAGE);
        const body = asRecord(res.body);
        if (res.status === 401 || res.status === 403) {
          const msg = safeMessage(body?.message, secrets);
          return FAIL(`上游拒绝了凭证（HTTP ${res.status}）${msg ? `：${msg}` : ''}，请检查访问令牌${upstream.userId ? '与用户 ID' : ''}`);
        }
        if (res.status !== 200) {
          const msg = safeMessage(body?.message, secrets);
          return FAIL(`上游返回 HTTP ${res.status}${msg ? `：${msg}` : ''}`);
        }
        if (!body) return FAIL('上游返回的不是 JSON，请检查站点地址是否指向 new-api');
        // new-api 的业务错误常以 HTTP 200 + success:false 返回
        if (body.success === false) {
          const msg = safeMessage(body.message, secrets);
          return FAIL(msg || '上游返回 success:false');
        }
        const data = asRecord(body.data);
        const quota = asNumber(data?.quota);
        if (!data || quota === undefined) return FAIL('上游响应缺少 data.quota 字段，请确认这是 new-api 站点');

        const perUnit = await quotaPerUnit(upstream.siteUrl, ctx);
        const balanceUsd = (quota / perUnit) * upstream.rateFactor;
        const raw: Record<string, unknown> = { quota, quota_per_unit: perUnit };
        const used = asNumber(data.used_quota);
        if (used !== undefined) raw.used_quota = used;
        return { ok: true, balanceUsd, mode: 'newapi', kind: 'wallet', raw, ...(discoveredUserId ? { discoveredUserId } : {}) };
      } catch (err) {
        if (err instanceof UpstreamRequestError) return FAIL(err.message);
        throw err;
      }
    },
  };
}
