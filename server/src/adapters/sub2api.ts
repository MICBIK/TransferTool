import { asNumber, asRecord, getJson, safeMessage, UpstreamRequestError } from './http.js';
import type { Adapter, AdapterDeps, BalanceResult } from './types.js';

const FAIL = (error: string, mode = 'unknown'): BalanceResult => ({ ok: false, mode, error });

/** 订阅制标记：字段存在且不是 null/false/空对象/空数组。 */
function hasSubscription(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  const rec = asRecord(v);
  if (rec) return Object.keys(rec).length > 0;
  return true;
}

/**
 * quota_limited 的剩余额度：宽松解析。
 * 先找直接给出的剩余字段，再用 limit - used 推算；都没有则返回 undefined（未知）。
 */
export function parseKeyRemaining(body: Record<string, unknown>): number | undefined {
  const quota = asRecord(body.quota);
  const direct = [
    body.remaining,
    body.quota_remaining,
    body.remaining_quota,
    body.remainingQuota,
    body.limit_remaining,
    quota?.remaining,
    quota?.quota_remaining,
    quota?.left,
  ];
  for (const candidate of direct) {
    const n = asNumber(candidate);
    if (n !== undefined) return n;
  }
  const limit = asNumber(quota?.limit ?? quota?.total ?? body.quota_limit ?? body.limit ?? body.total_quota);
  const used = asNumber(quota?.used ?? body.quota_used ?? body.used ?? body.used_quota);
  if (limit !== undefined && used !== undefined) return limit - used;
  return undefined;
}

export function createSub2ApiAdapter(deps: AdapterDeps): Adapter {
  return {
    async fetchBalance(upstream, ctx) {
      const secrets = [upstream.credential];
      try {
        const res = await getJson(deps.fetch, `${upstream.siteUrl}/v1/usage`, {
          timeoutMs: deps.timeoutMs,
          signal: ctx?.signal,
          headers: { Authorization: `Bearer ${upstream.credential}` },
        });
        const top = asRecord(res.body);
        if (res.status === 401 || res.status === 403) return FAIL('上游拒绝了 API Key（HTTP ' + res.status + '），请检查 Key 是否有效');
        if (res.status !== 200) {
          const err = top?.error;
          const msg = safeMessage(typeof err === 'string' ? err : (asRecord(err)?.message ?? top?.message), secrets);
          return FAIL(`上游返回 HTTP ${res.status}${msg ? `：${msg}` : ''}`);
        }
        if (!top) return FAIL('上游返回的不是 JSON，请检查站点地址是否指向 sub2api');
        // 兼容 { data: {...} } 包装
        const body = typeof top.mode !== 'string' && asRecord(top.data) ? (asRecord(top.data) as Record<string, unknown>) : top;

        if (hasSubscription(body.subscription) || hasSubscription(top.subscription)) {
          return { ok: false, mode: 'subscription', unsupported: true, error: '暂不支持订阅制' };
        }
        if (body.isValid === false) return FAIL('上游提示该 API Key 无效或已停用');

        const mode = typeof body.mode === 'string' ? body.mode : '';
        if (mode === 'unrestricted') {
          const balance = asNumber(body.balance);
          if (balance === undefined) return FAIL('上游响应缺少 balance 字段', mode);
          return { ok: true, balanceUsd: balance * upstream.rateFactor, mode, kind: 'wallet', raw: { mode, balance } };
        }
        if (mode === 'quota_limited') {
          const remaining = parseKeyRemaining(body);
          if (remaining === undefined) return FAIL('无法从响应中解析该 Key 的剩余额度，余额未知', mode);
          return { ok: true, balanceUsd: remaining * upstream.rateFactor, mode, kind: 'key_limit', raw: { mode, remaining } };
        }
        return FAIL(mode ? `暂不支持的 sub2api 模式：${safeMessage(mode, secrets, 40)}` : '上游响应缺少 mode 字段，请确认这是 sub2api 站点');
      } catch (err) {
        if (err instanceof UpstreamRequestError) return FAIL(err.message);
        throw err;
      }
    },
  };
}
