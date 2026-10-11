import { describe, expect, it } from 'vitest';
import { createAdapters, type AdapterUpstream } from '../src/adapters/index.js';
import { fakeFetch, jsonRes, type Handler } from './fakeFetch.js';

const SITE = 'https://up.example.com';
const base: AdapterUpstream = { type: 'newapi', siteUrl: SITE, credential: 'tok-secret-123', userId: '42', rateFactor: 1 };

function setup(handler: Handler, clock = { now: 1_000_000 }) {
  const f = fakeFetch(handler);
  const adapters = createAdapters({ fetch: f.fetch, clock: () => clock.now });
  return { ...f, adapters, clock };
}

const okSelf = (quota: number) => jsonRes({ success: true, data: { quota, used_quota: 10 } });
const status = (perUnit?: number) => jsonRes({ success: true, data: perUnit === undefined ? {} : { quota_per_unit: perUnit } });

describe('new-api 适配器', () => {
  it('Bearer + New-Api-User 成功，按 quota_per_unit 换算并乘汇率', async () => {
    const t = setup((c) => (c.url.endsWith('/api/status') ? status(100_000) : okSelf(250_000)));
    const r = await t.adapters.fetchBalance({ ...base, rateFactor: 0.5 });
    expect(r).toMatchObject({ ok: true, balanceUsd: 1.25, mode: 'newapi', kind: 'wallet' });
    const self = t.calls.find((c) => c.url.endsWith('/api/user/self'))!;
    expect(self.headers.authorization).toBe('Bearer tok-secret-123');
    expect(self.headers['new-api-user']).toBe('42');
    expect(self.headers['user-agent']).toContain('TransferTool');
    expect(self.redirect).toBe('manual');
    // /api/status 不应携带凭证
    const st = t.calls.find((c) => c.url.endsWith('/api/status'))!;
    expect(st.headers.authorization).toBeUndefined();
  });

  it('缺省 quota_per_unit 为 500000', async () => {
    const t = setup((c) => (c.url.endsWith('/api/status') ? status() : okSelf(1_000_000)));
    expect((await t.adapters.fetchBalance(base)).balanceUsd).toBe(2);
  });

  it('/api/status 失败时回退默认值，且失败不缓存', async () => {
    let statusOk = false;
    const t = setup((c) => {
      if (c.url.endsWith('/api/status')) return statusOk ? status(1000) : jsonRes({}, 500);
      return okSelf(1_000_000);
    });
    expect((await t.adapters.fetchBalance(base)).balanceUsd).toBe(2);
    statusOk = true;
    expect((await t.adapters.fetchBalance(base)).balanceUsd).toBe(1000);
  });

  it('quota_per_unit 缓存 24 小时', async () => {
    const t = setup((c) => (c.url.endsWith('/api/status') ? status(100_000) : okSelf(100_000)));
    const statusCalls = () => t.calls.filter((c) => c.url.endsWith('/api/status')).length;
    await t.adapters.fetchBalance(base);
    await t.adapters.fetchBalance(base);
    expect(statusCalls()).toBe(1);
    t.clock.now += 24 * 3600 * 1000 - 1;
    await t.adapters.fetchBalance(base);
    expect(statusCalls()).toBe(1);
    t.clock.now += 2;
    await t.adapters.fetchBalance(base);
    expect(statusCalls()).toBe(2);
  });

  it('401 后用旧写法（不带 Bearer）重试一次', async () => {
    const t = setup((c) => {
      if (c.url.endsWith('/api/status')) return status(500_000);
      return c.headers.authorization === 'tok-secret-123' ? okSelf(500_000) : jsonRes({ success: false, message: 'nope' }, 401);
    });
    const r = await t.adapters.fetchBalance(base);
    expect(r).toMatchObject({ ok: true, balanceUsd: 1 });
    const selfCalls = t.calls.filter((c) => c.url.endsWith('/api/user/self'));
    expect(selfCalls.map((c) => c.headers.authorization)).toEqual(['Bearer tok-secret-123', 'tok-secret-123']);
    expect(selfCalls[1]!.headers['new-api-user']).toBe('42');
  });

  it('403 同样触发回退；两次都被拒绝则报错且只重试一次', async () => {
    const t = setup(() => jsonRes({ success: false, message: 'forbidden' }, 403));
    const r = await t.adapters.fetchBalance(base);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
    expect(t.calls).toHaveLength(2);
  });

  it('旧令牌已停用：给出重新生成提示（HTTP 200 或 401 都识别）', async () => {
    const body = { success: false, code: 'ACCESS_TOKEN_LEGACY_RETIRED', message: 'legacy token retired' };
    for (const httpStatus of [200, 401]) {
      const t = setup(() => jsonRes(body, httpStatus));
      const r = await t.adapters.fetchBalance(base);
      expect(r).toMatchObject({ ok: false, error: '旧版访问令牌已失效，请到上游重新生成' });
    }
  });

  it('HTTP 200 + success:false 取 message，并抹掉其中的凭证', async () => {
    const t = setup(() => jsonRes({ success: false, message: 'bad token tok-secret-123 supplied' }));
    const r = await t.adapters.fetchBalance(base);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad token *** supplied');
  });

  it('缺少 New-Api-User 时不发该头', async () => {
    const t = setup((c) => (c.url.endsWith('/api/status') ? status(500_000) : okSelf(0)));
    const r = await t.adapters.fetchBalance({ ...base, userId: undefined });
    expect(r).toMatchObject({ ok: true, balanceUsd: 0 });
    expect(t.calls.find((c) => c.url.endsWith('/user/self'))!.headers['new-api-user']).toBeUndefined();
  });

  it('非 JSON、缺少 quota、5xx 都是失败', async () => {
    expect((await setup(() => new Response('<html>', { status: 200 })).adapters.fetchBalance(base)).error).toContain('不是 JSON');
    expect((await setup(() => jsonRes({ success: true, data: {} })).adapters.fetchBalance(base)).error).toContain('quota');
    expect((await setup(() => jsonRes({ message: 'oops' }, 502)).adapters.fetchBalance(base)).error).toContain('502');
  });

  it('重定向不跟随，也不会向其他主机发凭证', async () => {
    const t = setup(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/api/user/self' } }));
    const r = await t.adapters.fetchBalance(base);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('重定向');
    expect(t.calls).toHaveLength(1);
    expect(t.calls.every((c) => c.url.startsWith(SITE))).toBe(true);
  });

  it('网络错误与超时给出可读原因，不泄露凭证', async () => {
    const refused = setup(() => ({ throw: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }));
    const r1 = await refused.adapters.fetchBalance(base);
    expect(r1.error).toContain('ECONNREFUSED');

    // 用极短超时让 AbortSignal.timeout 真的触发
    const adapters = createAdapters({
      fetch: (async (_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch,
      clock: () => 0,
      timeoutMs: 20,
    });
    const r2 = await adapters.fetchBalance(base);
    expect(r2.error).toContain('超时');
    expect(JSON.stringify([r1, r2])).not.toContain('tok-secret-123');
  });

  it('外部取消信号会中止请求', async () => {
    const ctrl = new AbortController();
    const adapters = createAdapters({
      fetch: (async (_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch,
      clock: () => 0,
    });
    const p = adapters.fetchBalance(base, { signal: ctrl.signal });
    ctrl.abort();
    expect((await p).error).toBe('请求已取消');
  });
});
