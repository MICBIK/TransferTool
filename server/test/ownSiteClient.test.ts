import { describe, expect, it } from 'vitest';
import { createOwnSiteClient, type OwnSiteConn } from '../src/adapters/index.js';
import { fakeFetch, jsonRes, type Handler } from './fakeFetch.js';
import { fakeOwnSite, OWN, OWN_TOKEN, type FakeChannel } from './fakeOwnSite.js';

const conn: OwnSiteConn = { siteUrl: OWN, token: OWN_TOKEN, userId: '1' };
const clock = () => 0;
const mk = (handler: Handler) => {
  const ff = fakeFetch(handler);
  return { client: createOwnSiteClient({ fetch: ff.fetch, clock }), calls: ff.calls };
};
const channel = (id: number, over: Partial<FakeChannel> = {}): FakeChannel => ({ id, name: `c${id}`, base_url: '', group: 'default', status: 1, ...over });

describe('本站渠道客户端', () => {
  it('Bearer + New-Api-User；列表分两页，p 从 1 开始，不带渠道 key', async () => {
    const site = fakeOwnSite({ pageSize: 2 });
    site.state.channels = [1, 2, 3, 4, 5].map((id) => channel(id, { key: 'sk-LEAK', group: 'a, b,,a' }));
    const { client, calls } = mk(site.handle);
    const r = await client.listChannels(conn);
    expect(r.ok && r.channels.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(r)).not.toContain('sk-LEAK');
    expect(r.ok && r.channels[0]!.groups).toEqual(['a', 'b']);
    const pages = calls.map((c) => new URL(c.url).searchParams.get('p'));
    expect(pages.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OWN_TOKEN}`);
    expect(calls[0]!.headers['new-api-user']).toBe('1');
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[0]!.url).toContain('page_size=100');
  });

  it('data 为纯数组也能读', async () => {
    const { client } = mk(() => jsonRes({ success: true, data: [channel(7), { name: 'no-id' }] }));
    const r = await client.listChannels(conn);
    expect(r.ok && r.channels.map((c) => c.id)).toEqual([7]);
  });

  it('旧版从 p=0 起：补读 p=0 以免漏掉第一页', async () => {
    const site = fakeOwnSite({ pageSize: 2, zeroBased: true });
    site.state.channels = [1, 2, 3, 4, 5].map((id) => channel(id));
    const { client } = mk(site.handle);
    const r = await client.listChannels(conn);
    expect(r.ok && r.channels.map((c) => c.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('服务端忽略 p 总是返回同一页：没有新 id 时停止，不死循环', async () => {
    const { client, calls } = mk(() => jsonRes({ success: true, data: { items: [channel(1), channel(2)], total: 99 } }));
    const r = await client.listChannels(conn);
    expect(r.ok && r.channels).toHaveLength(2);
    expect(calls.length).toBeLessThan(6);
  });

  it('401 后用旧写法（无 Bearer）重试一次', async () => {
    const { client, calls } = mk((c) => (c.headers.authorization?.startsWith('Bearer') ? jsonRes({ success: false }, 401) : jsonRes({ success: true, data: { items: [], total: 0 } })));
    const r = await client.probe(conn);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${OWN_TOKEN}`, OWN_TOKEN]);
  });

  it('权限范围不足：不重试，清楚提示缺少的权限，消息中不泄露令牌', async () => {
    const { client, calls } = mk(() => jsonRes({ success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: `missing scope channel:write for ${OWN_TOKEN}` }, 403));
    const r = await client.setStatus(conn, 5, 2);
    expect(r).toMatchObject({ ok: false, kind: 'scope' });
    expect(!r.ok && r.error).toContain('本站令牌缺少权限：');
    expect(!r.ok && r.error).toContain('channel:write');
    expect(!r.ok && r.error).not.toContain(OWN_TOKEN);
    expect(calls).toHaveLength(1);
  });

  it('401/403 两种写法都被拒：提示检查令牌，且不含令牌', async () => {
    const { client } = mk(() => jsonRes({ success: false, message: `bad ${OWN_TOKEN}` }, 401));
    const r = await client.probe(conn);
    expect(!r.ok && r.error).toContain('拒绝了凭证');
    expect(!r.ok && r.error).not.toContain(OWN_TOKEN);
  });

  it('HTTP 200 + success:false 视为业务错误', async () => {
    const { client } = mk(() => jsonRes({ success: false, message: '无权进行此操作' }));
    expect(await client.listChannels(conn)).toMatchObject({ ok: false, kind: 'business', error: '无权进行此操作' });
  });

  it('重定向不跟随、超时/网络错误给出中文原因', async () => {
    const redirect = mk(() => new Response('', { status: 302, headers: { location: 'https://evil.example' } }));
    const r1 = await redirect.client.probe(conn);
    expect(!r1.ok && r1.error).toContain('重定向');
    expect(redirect.calls).toHaveLength(1);
    const net = mk(() => ({ throw: Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }) }));
    const r2 = await net.client.probe(conn);
    expect(!r2.ok && r2.error).toContain('ECONNREFUSED');
  });

  it('单个启停：POST /:id/status，body 只有 {status}', async () => {
    const site = fakeOwnSite();
    site.state.channels = [channel(3)];
    const { client, calls } = mk(site.handle);
    expect(await client.setStatus(conn, 3, 2)).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/channel/3/status');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 2 });
    expect(site.state.channels[0]!.status).toBe(2);
  });

  it('单个启停：404 回退 PUT /api/channel/ {id,status}，绝不发完整渠道对象', async () => {
    const calls2: { method: string; path: string; body?: string }[] = [];
    const { client } = mk((c) => {
      const path = new URL(c.url).pathname;
      calls2.push({ method: c.method, path, body: c.body });
      return path === '/api/channel/' && c.method === 'PUT' ? jsonRes({ success: true }) : new Response('404 page not found', { status: 404 });
    });
    expect(await client.setStatus(conn, 3, 1)).toEqual({ ok: true });
    expect(calls2.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/channel/3/status', 'PUT /api/channel/']);
    expect(JSON.parse(calls2[1]!.body!)).toEqual({ id: 3, status: 1 });
    expect(calls2.every((c) => c.method !== 'GET')).toBe(true); // 没有“先取再整体 PUT”
  });

  it('回退的 PUT 也失败：提示本站版本过旧，不再尝试别的写法', async () => {
    const seen: string[] = [];
    const { client } = mk((c) => {
      seen.push(`${c.method} ${new URL(c.url).pathname}`);
      return c.method === 'PUT' ? jsonRes({ success: false, message: '参数错误' }) : new Response('404', { status: 404 });
    });
    const r = await client.setStatus(conn, 3, 2);
    expect(r).toMatchObject({ ok: false, kind: 'unsupported', error: '本站版本过旧，不支持单独修改状态' });
    expect(seen).toEqual(['POST /api/channel/3/status', 'PUT /api/channel/']);
  });

  it('批量：POST /status/batch {ids,status}', async () => {
    const site = fakeOwnSite();
    site.state.channels = [channel(1), channel(2), channel(3)];
    const { client, calls } = mk(site.handle);
    const r = await client.setStatusMany(conn, [1, 2, 2, 3], 2);
    expect(r).toEqual({ succeeded: [1, 2, 3], failed: [] });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ids: [1, 2, 3], status: 2 });
  });

  it('批量：没有批量接口时逐个调用，并返回逐个结果', async () => {
    const site = fakeOwnSite({ batch: false });
    site.state.channels = [channel(1), channel(2), channel(3)];
    site.state.failIds.add(2);
    const { client, calls } = mk(site.handle);
    const r = await client.setStatusMany(conn, [1, 2, 3], 2);
    expect(r.succeeded).toEqual([1, 3]);
    expect(r.failed).toEqual([{ id: 2, error: '渠道不存在' }]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/channel/status/batch', '/api/channel/1/status', '/api/channel/2/status', '/api/channel/3/status']);
  });

  it('批量：权限不足时整体失败且不再逐个重试', async () => {
    const { client, calls } = mk(() => jsonRes({ success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: 'channel:write' }, 403));
    const r = await client.setStatusMany(conn, [1, 2, 3], 2);
    expect(r.succeeded).toEqual([]);
    expect(r.failed.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(r.failed[0]!.error).toContain('缺少权限');
    expect(calls).toHaveLength(1);
  });

  it('逐个回退中遇到致命错误（权限/网络）后，其余直接标为失败', async () => {
    let n = 0;
    const { client } = mk((c) => {
      if (c.url.endsWith('/status/batch')) return new Response('404', { status: 404 });
      n++;
      return n === 1 ? jsonRes({ success: true }) : { throw: new Error('down') };
    });
    const r = await client.setStatusMany(conn, [1, 2, 3, 4], 1);
    expect(r.succeeded).toEqual([1]);
    expect(r.failed.map((f) => f.id)).toEqual([2, 3, 4]);
    expect(n).toBe(2);
  });

  it('渠道测试：GET /api/channel/test/:id，success:false 是“测试未通过”而不是请求失败', async () => {
    const site = fakeOwnSite();
    const { client, calls } = mk(site.handle);
    expect(await client.testChannel(conn, 9)).toEqual({ ok: true, result: { passed: true, message: '', timeSeconds: 0.42 } });
    site.state.testResult = { success: false, message: 'status 401', time: 0.1 };
    const bad = await client.testChannel(conn, 9);
    expect(bad).toMatchObject({ ok: true, result: { passed: false, message: 'status 401' } });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/channel/test/9');
  });
});
