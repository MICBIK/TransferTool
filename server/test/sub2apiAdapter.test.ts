import { describe, expect, it } from 'vitest';
import { createAdapters, type AdapterUpstream } from '../src/adapters/index.js';
import { fakeFetch, jsonRes, type Handler } from './fakeFetch.js';

const base: AdapterUpstream = { type: 'sub2api', siteUrl: 'https://s2a.example.com', credential: 'sk-key-abcdef', rateFactor: 1 };

function setup(handler: Handler) {
  const f = fakeFetch(handler);
  return { ...f, adapters: createAdapters({ fetch: f.fetch, clock: () => 0 }) };
}

describe('sub2api 适配器', () => {
  it('unrestricted：balance 即钱包余额（USD），带 Bearer', async () => {
    const t = setup(() => jsonRes({ isValid: true, mode: 'unrestricted', balance: 12.5 }));
    const r = await t.adapters.fetchBalance({ ...base, rateFactor: 2 });
    expect(r).toMatchObject({ ok: true, balanceUsd: 25, mode: 'unrestricted', kind: 'wallet' });
    expect(t.calls[0]!.url).toBe('https://s2a.example.com/v1/usage');
    expect(t.calls[0]!.headers.authorization).toBe('Bearer sk-key-abcdef');
    expect(t.calls[0]!.redirect).toBe('manual');
  });

  it('unrestricted 缺少 balance 视为失败', async () => {
    const r = await setup(() => jsonRes({ mode: 'unrestricted' })).adapters.fetchBalance(base);
    expect(r.ok).toBe(false);
  });

  it.each([
    ['remaining', { remaining: 7.5 }, 7.5],
    ['quota_remaining', { quota_remaining: '3.25' }, 3.25],
    ['quota.remaining', { quota: { limit: 10, used: 1, remaining: 9 } }, 9],
    ['quota.limit - quota.used', { quota: { limit: 10, used: 4 } }, 6],
  ])('quota_limited：宽松解析 %s，标为 Key 限额', async (_name, extra, expected) => {
    const r = await setup(() => jsonRes({ mode: 'quota_limited', ...extra })).adapters.fetchBalance(base);
    expect(r).toMatchObject({ ok: true, balanceUsd: expected, mode: 'quota_limited', kind: 'key_limit' });
  });

  it('quota_limited 取不到剩余额度：标为未知（失败），不是 0', async () => {
    const r = await setup(() => jsonRes({ mode: 'quota_limited', something: 1 })).adapters.fetchBalance(base);
    expect(r.ok).toBe(false);
    expect(r.balanceUsd).toBeUndefined();
    expect(r.error).toContain('未知');
  });

  it('出现 subscription 字段：暂不支持订阅制，不是失败也没有余额', async () => {
    const r = await setup(() => jsonRes({ mode: 'unrestricted', balance: 5, subscription: { daily_limit_usd: 10 } })).adapters.fetchBalance(base);
    expect(r).toMatchObject({ ok: false, unsupported: true, mode: 'subscription', error: '暂不支持订阅制' });
    expect(r.balanceUsd).toBeUndefined();
  });

  it('subscription 为 null 不算订阅制', async () => {
    const r = await setup(() => jsonRes({ mode: 'unrestricted', balance: 5, subscription: null })).adapters.fetchBalance(base);
    expect(r).toMatchObject({ ok: true, balanceUsd: 5 });
  });

  it('401、未知 mode、非 JSON、{data} 包装', async () => {
    expect((await setup(() => jsonRes({ error: 'x' }, 401)).adapters.fetchBalance(base)).error).toContain('401');
    expect((await setup(() => jsonRes({ mode: 'weird' })).adapters.fetchBalance(base)).error).toContain('weird');
    expect((await setup(() => new Response('nope')).adapters.fetchBalance(base)).error).toContain('不是 JSON');
    const wrapped = await setup(() => jsonRes({ data: { mode: 'unrestricted', balance: 1 } })).adapters.fetchBalance(base);
    expect(wrapped.balanceUsd).toBe(1);
  });

  it('重定向不跟随', async () => {
    const t = setup(() => new Response(null, { status: 301, headers: { location: 'https://evil.example.net/' } }));
    const r = await t.adapters.fetchBalance(base);
    expect(r.error).toContain('重定向');
    expect(t.calls).toHaveLength(1);
  });
});
