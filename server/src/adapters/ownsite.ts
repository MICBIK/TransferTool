import { asNumber, asRecord, requestJson, safeMessage, UpstreamRequestError, type JsonResponse } from './http.js';
import type { AdapterDeps, FetchContext } from './types.js';

/** 本站 new-api 连接信息：令牌已解密，仅在内存中短暂存在。 */
export interface OwnSiteConn {
  /** 已规范化（无尾部斜杠，仅 http/https） */
  siteUrl: string;
  token: string;
  /** New-Api-User 头（可选，旧版兼容） */
  userId?: string;
}

/** 渠道缓存所需的字段。刻意不含渠道 key：解析时只挑选这些字段，其余一律丢弃。 */
export interface SiteChannel {
  id: number;
  name: string;
  type: number;
  baseUrl: string;
  groups: string[];
  /** 1 启用、2 手动禁用、3 自动禁用（只读） */
  status: number;
  priority: number;
  weight: number;
  /** 毫秒 */
  responseTime: number;
  tag: string;
}

export type SiteErrorKind = 'scope' | 'auth' | 'network' | 'unsupported' | 'notfound' | 'business' | 'http';
export type SiteResult<T> = ({ ok: true } & T) | { ok: false; kind: SiteErrorKind; error: string };

export type ChannelStatus = 1 | 2;

export interface StatusManyResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

export interface ChannelTestResult {
  passed: boolean;
  message: string;
  /** 秒 */
  timeSeconds: number | null;
}

export const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const BATCH_CHUNK = 200;
export const TEST_TIMEOUT_MS = 60_000;
export const OLD_VERSION_MESSAGE = '本站版本过旧，不支持单独修改状态';
const SCOPE_CODE = 'ACCESS_TOKEN_SCOPE_DENIED';
const LEGACY_RETIRED_CODE = 'ACCESS_TOKEN_LEGACY_RETIRED';

type Outcome = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; kind: SiteErrorKind; error: string; status?: number };

function mentions(res: JsonResponse, needle: string): boolean {
  const body = asRecord(res.body);
  if (!body) return false;
  const err = asRecord(body.error);
  return [body.code, body.message, err?.code, err?.message].some((v) => typeof v === 'string' && v.includes(needle));
}

/** 本站渠道接口（new-api /api/channel/*）。全部请求经注入的 fetch；不请求、不保存渠道 key。 */
export function createOwnSiteClient(deps: AdapterDeps) {
  function headers(conn: OwnSiteConn, authorization: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: authorization };
    if (conn.userId) h['New-Api-User'] = conn.userId;
    return h;
  }

  /** 发请求并归类结果；401/403（非权限范围不足）时用旧写法重试一次。 */
  async function send(
    conn: OwnSiteConn,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { body?: unknown; timeoutMs?: number; ctx?: FetchContext; allowBusiness?: boolean } = {},
  ): Promise<Outcome> {
    const url = `${conn.siteUrl}${path}`;
    const secrets = [conn.token];
    const base = { method, body: opts.body, timeoutMs: opts.timeoutMs ?? deps.timeoutMs, signal: opts.ctx?.signal };
    try {
      let res = await requestJson(deps.fetch, url, { ...base, headers: headers(conn, `Bearer ${conn.token}`) });
      if ((res.status === 401 || res.status === 403) && !mentions(res, SCOPE_CODE)) {
        // 旧版 new-api：Authorization 直接放令牌（不带 Bearer）
        res = await requestJson(deps.fetch, url, { ...base, headers: headers(conn, conn.token) });
      }
      const body = asRecord(res.body);
      const msg = safeMessage(body?.message ?? asRecord(body?.error)?.message, secrets);

      if (mentions(res, SCOPE_CODE)) return { ok: false, kind: 'scope', status: res.status, error: `本站令牌缺少权限：${msg || '请为令牌授予渠道读取、渠道操作与 log:read 权限'}` };
      if (mentions(res, LEGACY_RETIRED_CODE)) return { ok: false, kind: 'auth', status: res.status, error: '旧版访问令牌已失效，请到本站重新生成' };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, kind: 'auth', status: res.status, error: `本站拒绝了凭证（HTTP ${res.status}）${msg ? `：${msg}` : ''}，请检查访问令牌与用户 ID` };
      }
      if (res.status === 404 || res.status === 405) return { ok: false, kind: 'notfound', status: res.status, error: `本站返回 HTTP ${res.status}` };
      if (res.status < 200 || res.status >= 300) return { ok: false, kind: 'http', status: res.status, error: `本站返回 HTTP ${res.status}${msg ? `：${msg}` : ''}` };
      if (!body) return { ok: false, kind: 'http', status: res.status, error: '本站返回的不是 JSON，请检查本站地址是否指向 new-api' };
      // new-api 的业务错误常以 HTTP 200 + success:false 返回
      if (body.success === false && !opts.allowBusiness) return { ok: false, kind: 'business', status: res.status, error: msg || '本站返回 success:false' };
      return { ok: true, status: res.status, body };
    } catch (err) {
      if (err instanceof UpstreamRequestError) return { ok: false, kind: 'network', error: err.message };
      throw err;
    }
  }

  const isFatal = (kind: SiteErrorKind) => kind === 'scope' || kind === 'auth' || kind === 'network' || kind === 'unsupported';

  function parseChannel(raw: unknown): SiteChannel | null {
    const r = asRecord(raw);
    const id = asNumber(r?.id);
    if (!r || id === undefined || !Number.isInteger(id) || id <= 0) return null;
    const group = typeof r.group === 'string' ? r.group : '';
    return {
      id,
      name: typeof r.name === 'string' ? r.name : `#${id}`,
      type: asNumber(r.type) ?? 0,
      baseUrl: typeof r.base_url === 'string' ? r.base_url.trim() : '',
      groups: [...new Set(group.split(',').map((g) => g.trim()).filter(Boolean))],
      status: asNumber(r.status) ?? 0,
      priority: asNumber(r.priority) ?? 0,
      weight: asNumber(r.weight) ?? 0,
      responseTime: asNumber(r.response_time) ?? 0,
      tag: typeof r.tag === 'string' ? r.tag : '',
    };
  }

  /** 兼容 data.items / data 为数组两种形态。 */
  function pageItems(body: Record<string, unknown>): { items: unknown[]; total?: number } | null {
    const data = body.data;
    if (Array.isArray(data)) return { items: data };
    const rec = asRecord(data);
    if (rec && Array.isArray(rec.items)) return { items: rec.items, total: asNumber(rec.total) };
    return null;
  }

  async function fetchPage(conn: OwnSiteConn, p: number, pageSize: number, ctx?: FetchContext) {
    const out = await send(conn, 'GET', `/api/channel/?p=${p}&page_size=${pageSize}`, { ctx });
    if (!out.ok) return out;
    const page = pageItems(out.body);
    if (!page) return { ok: false as const, kind: 'http' as const, error: '本站渠道列表的格式无法识别，请确认这是 new-api 站点' };
    return { ok: true as const, ...page };
  }

  return {
    /** 测试连接：只读一页（1 条），不写任何数据。 */
    async probe(conn: OwnSiteConn, ctx?: FetchContext): Promise<SiteResult<{ total: number | null }>> {
      const page = await fetchPage(conn, 1, 1, ctx);
      if (!page.ok) return page;
      return { ok: true, total: page.total ?? null };
    },

    /**
     * 拉取全部渠道。p 从 1 开始（旧版从 0 开始）：翻页直到某页没有新 id；
     * 若累计数量仍小于 total，再补读一次 p=0，兼容旧版。
     */
    async listChannels(conn: OwnSiteConn, ctx?: FetchContext): Promise<SiteResult<{ channels: SiteChannel[] }>> {
      const byId = new Map<number, SiteChannel>();
      let total: number | undefined;
      const absorb = (items: unknown[]): number => {
        let added = 0;
        for (const raw of items) {
          const c = parseChannel(raw);
          if (c && !byId.has(c.id)) {
            byId.set(c.id, c);
            added++;
          }
        }
        return added;
      };
      for (let p = 1; p <= MAX_PAGES; p++) {
        const page = await fetchPage(conn, p, PAGE_SIZE, ctx);
        if (!page.ok) return page;
        total = page.total ?? total;
        if (absorb(page.items) === 0) break;
        if (total !== undefined && byId.size >= total) break;
      }
      if (total !== undefined && byId.size < total) {
        const zero = await fetchPage(conn, 0, PAGE_SIZE, ctx);
        if (!zero.ok) return zero;
        absorb(zero.items);
      }
      return { ok: true, channels: [...byId.values()] };
    },

    /** 启停单个渠道：POST /:id/status；404/405（旧版）回退 PUT {id,status}，绝不发送完整渠道对象。 */
    async setStatus(conn: OwnSiteConn, id: number, status: ChannelStatus, ctx?: FetchContext): Promise<SiteResult<object>> {
      return setStatusOne(conn, id, status, { legacy: false }, ctx);
    },

    /** 批量启停：POST /status/batch；404/405 回退为逐个调用。返回逐个渠道的结果。 */
    async setStatusMany(conn: OwnSiteConn, ids: number[], status: ChannelStatus, ctx?: FetchContext): Promise<StatusManyResult> {
      const result: StatusManyResult = { succeeded: [], failed: [] };
      const unique = [...new Set(ids)];
      let sequential = false;
      let abortedWith: string | null = null;
      for (let i = 0; i < unique.length; i += BATCH_CHUNK) {
        const chunk = unique.slice(i, i + BATCH_CHUNK);
        if (abortedWith) {
          for (const id of chunk) result.failed.push({ id, error: abortedWith });
          continue;
        }
        if (!sequential) {
          const out = await send(conn, 'POST', '/api/channel/status/batch', { body: { ids: chunk, status }, ctx });
          if (out.ok) {
            result.succeeded.push(...chunk);
            continue;
          }
          if (out.kind !== 'notfound') {
            for (const id of chunk) result.failed.push({ id, error: out.error });
            if (isFatal(out.kind)) abortedWith = out.error;
            continue;
          }
          sequential = true; // 本站没有批量接口：本批及之后都逐个调用
        }
        const mode = { legacy: false };
        for (const id of chunk) {
          if (abortedWith) {
            result.failed.push({ id, error: abortedWith });
            continue;
          }
          const one = await setStatusOne(conn, id, status, mode, ctx);
          if (one.ok) result.succeeded.push(id);
          else {
            result.failed.push({ id, error: one.error });
            if (isFatal(one.kind)) abortedWith = one.error;
          }
        }
      }
      return result;
    },

    /** 渠道测试可能很慢（本站要真的请求上游），超时放宽到 60 秒。 */
    async testChannel(conn: OwnSiteConn, id: number, ctx?: FetchContext): Promise<SiteResult<{ result: ChannelTestResult }>> {
      const out = await send(conn, 'GET', `/api/channel/test/${id}`, { timeoutMs: TEST_TIMEOUT_MS, ctx, allowBusiness: true });
      if (!out.ok) return out;
      const message = safeMessage(out.body.message, [conn.token], 300);
      const time = asNumber(out.body.time);
      return { ok: true, result: { passed: out.body.success !== false, message, timeSeconds: time ?? null } };
    },
  };

  async function setStatusOne(conn: OwnSiteConn, id: number, status: ChannelStatus, mode: { legacy: boolean }, ctx?: FetchContext): Promise<SiteResult<object>> {
    if (!mode.legacy) {
      const out = await send(conn, 'POST', `/api/channel/${id}/status`, { body: { status }, ctx });
      if (out.ok) return { ok: true };
      if (out.kind !== 'notfound') return out;
      mode.legacy = true;
    }
    const legacy = await send(conn, 'PUT', '/api/channel/', { body: { id, status }, ctx });
    if (legacy.ok) return { ok: true };
    if (legacy.kind === 'scope' || legacy.kind === 'auth' || legacy.kind === 'network') return legacy;
    return { ok: false, kind: 'unsupported', error: OLD_VERSION_MESSAGE };
  }
}

export type OwnSiteClient = ReturnType<typeof createOwnSiteClient>;
