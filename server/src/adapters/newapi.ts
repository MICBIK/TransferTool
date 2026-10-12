import { asNumber, asRecord, getJson, safeMessage, UpstreamRequestError, type JsonResponse } from './http.js';
import type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, FetchContext } from './types.js';

export const DEFAULT_QUOTA_PER_UNIT = 500_000;
export const QUOTA_PER_UNIT_TTL_MS = 24 * 3600 * 1000;
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

  return {
    async fetchBalance(upstream, ctx) {
      const url = `${upstream.siteUrl}/api/user/self`;
      const secrets = [upstream.credential];
      const opts = { timeoutMs: deps.timeoutMs, signal: ctx?.signal };
      try {
        let res = await getJson(deps.fetch, url, { ...opts, headers: headers(upstream, `Bearer ${upstream.credential}`) });
        if (res.status === 401 || res.status === 403) {
          // 旧版 new-api：Authorization 直接放令牌（不带 Bearer）
          res = await getJson(deps.fetch, url, { ...opts, headers: headers(upstream, upstream.credential) });
        }

        if (isLegacyRetired(res)) return FAIL(LEGACY_RETIRED_MESSAGE);
        const body = asRecord(res.body);
        if (res.status === 401 || res.status === 403) {
          const msg = safeMessage(body?.message, secrets);
          return FAIL(`上游拒绝了凭证（HTTP ${res.status}）${msg ? `：${msg}` : ''}，请检查访问令牌与用户 ID`);
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
        return { ok: true, balanceUsd, mode: 'newapi', kind: 'wallet', raw };
      } catch (err) {
        if (err instanceof UpstreamRequestError) return FAIL(err.message);
        throw err;
      }
    },
  };
}
