import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, channels, settings } from '../src/db/schema.js';
import { jsonRes } from './fakeFetch.js';
import { fakeOwnSite, OWN, OWN_TOKEN, type FakeChannel } from './fakeOwnSite.js';
import { json, login, makeHarness, request, type Harness } from './helpers.js';

const ch = (id: number, base_url: string, over: Partial<FakeChannel> = {}): FakeChannel => ({ id, name: `渠道${id}`, base_url, group: 'default', status: 1, key: `sk-SECRET-${id}`, ...over });

/** 把假本站和各上游余额接到同一个假 fetch 上。balances 以主机名为键。 */
function wire(h: Harness, site: ReturnType<typeof fakeOwnSite>, balances: Record<string, number | 'fail'>) {
  h.upstream.handler = (c) => {
    if (c.url.startsWith(OWN)) return site.handle(c);
    const host = new URL(c.url).hostname;
    if (c.url.endsWith('/api/status')) return jsonRes({ success: true, data: { quota_per_unit: 500000 } });
    if (c.url.endsWith('/v1/usage')) return jsonRes({ mode: 'quota_limited', remaining: balances[host] });
    const b = balances[host];
    if (b === 'fail' || b === undefined) return jsonRes({ success: false, message: 'down' }, 500);
    return jsonRes({ success: true, data: { quota: Math.round(b * 500000) } });
  };
}

async function setup(opts: Parameters<typeof fakeOwnSite>[0] = {}) {
  const h = await makeHarness();
  const cookie = await login(h);
  const site = fakeOwnSite(opts);
  return { h, cookie, site };
}

async function connect(h: Harness, cookie: string) {
  const res = await request(h, 'PUT', '/api/settings/own-site', { url: `${OWN}/`, token: OWN_TOKEN, userId: '1' }, { cookie });
  expect(res.status).toBe(200);
  return json(res);
}

function addUpstream(h: Harness, host: string, over: Record<string, unknown> = {}) {
  return h.s.upstreams.create({ name: host, type: 'newapi', siteUrl: `https://${host}`, credential: 'tok-up', threshold: 5, ...over } as never);
}

const statusOf = (h: Harness, id: number) => h.s.channels.find(id)?.status;
const actions = (h: Harness) => h.db.select().from(auditLog).all().map((r) => r.action);

describe('本站连接设置', () => {
  it('需要登录；令牌加密落库且接口只回掩码', async () => {
    const { h, cookie } = await setup();
    for (const [m, p] of [['GET', '/api/settings/own-site'], ['PUT', '/api/settings/own-site'], ['POST', '/api/settings/own-site/test'], ['GET', '/api/channels'], ['GET', '/api/channels/summary'], ['POST', '/api/channels/sync'], ['POST', '/api/channels/status'], ['POST', '/api/channels/1/status'], ['POST', '/api/channels/1/test'], ['PUT', '/api/channels/1/upstream'], ['POST', '/api/channels/upstream/1/status']] as const) {
      expect((await request(h, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(401);
    }
    const view = await connect(h, cookie);
    expect(JSON.stringify(view)).not.toContain(OWN_TOKEN);
    expect(view).toMatchObject({ url: OWN, tokenSet: true, userIdSet: true, configured: true, token: '********' });
    const raw = h.db.select().from(settings).where(eq(settings.key, 'own_site_token')).get()!;
    expect(raw.encrypted).toBe(true);
    expect(raw.value.startsWith('enc:v1:')).toBe(true);
    expect(raw.value).not.toContain(OWN_TOKEN);
    expect(h.db.select().from(settings).where(eq(settings.key, 'own_site_user_id')).get()!.value.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(h.db.select().from(auditLog).all())).not.toContain(OWN_TOKEN);
  });

  it('留空/掩码不修改；换了主机必须重填令牌；userId 可清除；url 置空即断开', async () => {
    const { h, cookie } = await setup();
    await connect(h, cookie);
    const keep = await request(h, 'PUT', '/api/settings/own-site', { url: OWN, token: '********', userId: '' }, { cookie });
    expect(await json(keep)).toMatchObject({ tokenSet: true, userIdSet: true });
    expect(h.s.ownSite.connection()).toMatchObject({ token: OWN_TOKEN, userId: '1' });

    const moved = await request(h, 'PUT', '/api/settings/own-site', { url: 'https://other.example.com' }, { cookie });
    expect(moved.status).toBe(400);
    expect(h.s.ownSite.connection()!.siteUrl).toBe(OWN);

    await request(h, 'PUT', '/api/settings/own-site', { userId: null }, { cookie });
    expect(h.s.ownSite.connection()!.userId).toBeUndefined();
    expect((await request(h, 'PUT', '/api/settings/own-site', { url: 'ftp://x' }, { cookie })).status).toBe(400);

    const off = await request(h, 'PUT', '/api/settings/own-site', { url: '' }, { cookie });
    expect(await json(off)).toMatchObject({ url: '', configured: false, tokenSet: false });
    expect(h.s.ownSite.connection()).toBeNull();
  });

  it('测试连接：成功给出渠道数；权限不足时提示缺少的权限；不落库', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, ''), ch(2, '')];
    wire(h, site, {});
    const okRes = await request(h, 'POST', '/api/settings/own-site/test', { url: OWN, token: OWN_TOKEN }, { cookie });
    expect(await json(okRes)).toEqual({ ok: true, total: 2, error: null });
    expect(h.s.ownSite.connection()).toBeNull();

    h.upstream.handler = () => jsonRes({ success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: 'scope channel:read required' }, 403);
    const denied = await json(await request(h, 'POST', '/api/settings/own-site/test', { url: OWN, token: OWN_TOKEN }, { cookie }));
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('本站令牌缺少权限：');
    expect(denied.error).toContain('channel:read');

    expect((await request(h, 'POST', '/api/settings/own-site/test', { url: OWN }, { cookie })).status).toBe(400); // 没有令牌
  });
});

describe('渠道同步与归类', () => {
  it('分页同步、按匹配域名自动归类（含子域）、空 base_url 不归类、不存 key', async () => {
    const { h, cookie, site } = await setup({ pageSize: 2 });
    const a = addUpstream(h, 'a.example.com');
    const b = addUpstream(h, 'b.example.com', { matchDomains: ['b.example.com', 'b-alt.net'] });
    site.state.channels = [ch(1, 'https://a.example.com'), ch(2, 'https://eu.a.example.com/v1'), ch(3, 'http://B-ALT.net:8080'), ch(4, ''), ch(5, 'https://evil-a.example.com'), ch(6, 'https://other.io', { group: 'vip,default' })];
    wire(h, site, {});
    const view = await connect(h, cookie);
    expect(view.sync).toMatchObject({ ok: true, total: 6, added: 6 });

    const list = await json(await request(h, 'GET', '/api/channels', undefined, { cookie }));
    const by = Object.fromEntries(list.channels.map((c: { id: number; upstreamId: number | null }) => [c.id, c.upstreamId]));
    expect(by).toEqual({ 1: a.id, 2: a.id, 3: b.id, 4: null, 5: null, 6: null });
    expect(list.channels.find((c: { id: number }) => c.id === 6).groups).toEqual(['vip', 'default']);
    expect(list.configured).toBe(true);
    expect(JSON.stringify(h.db.select().from(channels).all())).not.toContain('SECRET');
    expect(JSON.stringify(list)).not.toContain('SECRET');

    const sum = await json(await request(h, 'GET', '/api/channels/summary', undefined, { cookie }));
    expect(sum.summary).toEqual(expect.arrayContaining([{ upstreamId: a.id, enabled: 2, total: 2 }, { upstreamId: null, enabled: 3, total: 3 }]));
  });

  it('手动指定优先且不被同步覆盖；取消手动后恢复自动归类；上游新增匹配域名后立即重归类', async () => {
    const { h, cookie, site } = await setup();
    const a = addUpstream(h, 'a.example.com');
    const b = addUpstream(h, 'b.example.com');
    site.state.channels = [ch(1, 'https://a.example.com'), ch(2, 'https://zzz.io')];
    wire(h, site, {});
    await connect(h, cookie);

    // 把自动归到 a 的渠道 1 手动指给 b；未归类的 2 手动指给 a
    expect((await request(h, 'PUT', '/api/channels/1/upstream', { upstreamId: b.id }, { cookie })).status).toBe(200);
    expect((await request(h, 'PUT', '/api/channels/2/upstream', { upstreamId: a.id }, { cookie })).status).toBe(200);
    await h.s.channels.sync();
    expect(h.s.channels.find(1)).toMatchObject({ upstreamId: b.id, manualUpstream: true });
    expect(h.s.channels.find(2)).toMatchObject({ upstreamId: a.id, manualUpstream: true });

    expect((await request(h, 'PUT', '/api/channels/1/upstream', { upstreamId: null }, { cookie })).status).toBe(200);
    expect(h.s.channels.find(1)).toMatchObject({ upstreamId: a.id, manualUpstream: false });
    expect((await request(h, 'PUT', '/api/channels/1/upstream', { upstreamId: 999 }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/channels/404/upstream', { upstreamId: null }, { cookie })).status).toBe(404);

    // 给 b 增加匹配域名 zzz.io：只影响非手动指定的
    h.s.channels.find(2); // 2 是手动指给 a 的，保持
    await request(h, 'PUT', `/api/upstreams/${b.id}`, { matchDomains: ['b.example.com', 'zzz.io'] }, { cookie });
    expect(h.s.channels.find(2)!.upstreamId).toBe(a.id);
    await request(h, 'PUT', '/api/channels/2/upstream', { upstreamId: null }, { cookie });
    expect(h.s.channels.find(2)!.upstreamId).toBe(b.id);
    expect(actions(h)).toContain('channel.upstream_assigned');
  });

  it('本站删除的渠道从缓存移除；同步失败时缓存原样保留并报告原因', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, ''), ch(2, ''), ch(3, '')];
    wire(h, site, {});
    await connect(h, cookie);
    site.state.channels = [ch(1, ''), ch(3, '', { name: '改名了' })];
    expect(await h.s.channels.sync()).toMatchObject({ ok: true, removed: 1, total: 2 });
    expect(h.s.channels.views().map((c) => c.id)).toEqual([1, 3]);
    expect(h.s.channels.find(3)!.name).toBe('改名了');

    const real = h.upstream.handler;
    h.upstream.handler = () => jsonRes({ success: false, message: 'maintenance' }, 503);
    const res = await json(await request(h, 'POST', '/api/channels/sync', {}, { cookie }));
    expect(res.result).toMatchObject({ ok: false });
    expect(res.result.error).toContain('503');
    expect(res.channels).toHaveLength(2);
    expect(res.lastError).toContain('503');
    h.upstream.handler = real;
    expect((await h.s.channels.sync()).ok).toBe(true);
    expect(h.s.channels.lastError).toBeNull();
  });

  it('未配置本站时：同步返回原因，启停给出明确提示', async () => {
    const { h, cookie } = await setup();
    const r = await json(await request(h, 'POST', '/api/channels/sync', {}, { cookie }));
    expect(r.result.ok).toBe(false);
    expect(r.configured).toBe(false);
    const st = await request(h, 'POST', '/api/channels/1/status', { status: 2 }, { cookie });
    expect(st.status).toBe(400);
  });

  it('上游被删除后，其手动指定的渠道退回自动归类/未归类', async () => {
    const { h, cookie, site } = await setup();
    const a = addUpstream(h, 'a.example.com');
    site.state.channels = [ch(1, 'https://zzz.io')];
    wire(h, site, {});
    await connect(h, cookie);
    await request(h, 'PUT', '/api/channels/1/upstream', { upstreamId: a.id }, { cookie });
    await request(h, 'DELETE', `/api/upstreams/${a.id}`, undefined, { cookie });
    expect(h.s.channels.find(1)).toMatchObject({ upstreamId: null, manualUpstream: false });
  });
});

describe('渠道启停与测试', () => {
  it('单个启停：成功后更新缓存并写审计；失败时缓存不变并返回原因', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, ''), ch(2, '')];
    wire(h, site, {});
    await connect(h, cookie);
    const ok = await request(h, 'POST', '/api/channels/1/status', { status: 2 }, { cookie });
    expect(ok.status).toBe(200);
    expect(statusOf(h, 1)).toBe(2);
    expect(site.state.channels[0]!.status).toBe(2);
    const sent = site.state.calls.filter((c) => c.method === 'POST').at(-1)!;
    expect(JSON.parse(sent.body!)).toEqual({ status: 2 });
    expect(actions(h)).toContain('channel.status_changed');

    site.state.failWrites = true;
    const bad = await request(h, 'POST', '/api/channels/2/status', { status: 2 }, { cookie });
    expect(bad.status).toBe(502);
    expect((await json(bad)).error.message).toContain('500');
    expect(statusOf(h, 2)).toBe(1);

    expect((await request(h, 'POST', '/api/channels/1/status', { status: 3 }, { cookie })).status).toBe(400); // 3 只读
    expect((await request(h, 'POST', '/api/channels/99/status', { status: 2 }, { cookie })).status).toBe(502);
  });

  it('批量启停：一次批量请求，逐个报告结果；未知 id 记为失败', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, ''), ch(2, ''), ch(3, '')];
    wire(h, site, {});
    await connect(h, cookie);
    const before = site.state.calls.length;
    const res = await json(await request(h, 'POST', '/api/channels/status', { ids: [1, 2, 77], status: 2 }, { cookie }));
    expect(res.result.succeeded).toEqual([1, 2]);
    expect(res.result.failed).toHaveLength(1);
    expect(res.result.failed[0].id).toBe(77);
    expect(site.state.calls.slice(before).filter((c) => c.method === 'POST')).toHaveLength(1);
    expect([1, 2, 3].map((id) => statusOf(h, id))).toEqual([2, 2, 1]);
    expect(actions(h)).toContain('channel.batch_status_changed');
    expect((await request(h, 'POST', '/api/channels/status', { ids: [], status: 2 }, { cookie })).status).toBe(400);
  });

  it('上游一键停用只动启用中的、一键启用只动手动停用的（本站自动禁用的不动）', async () => {
    const { h, cookie, site } = await setup();
    const a = addUpstream(h, 'a.example.com');
    site.state.channels = [ch(1, 'https://a.example.com'), ch(2, 'https://a.example.com', { status: 2 }), ch(3, 'https://a.example.com', { status: 3 }), ch(4, 'https://x.io')];
    wire(h, site, {});
    await connect(h, cookie);
    const off = await json(await request(h, 'POST', `/api/channels/upstream/${a.id}/status`, { status: 2 }, { cookie }));
    expect(off.result.succeeded).toEqual([1]);
    expect([1, 2, 3, 4].map((id) => statusOf(h, id))).toEqual([2, 2, 3, 1]);
    const on = await json(await request(h, 'POST', `/api/channels/upstream/${a.id}/status`, { status: 1 }, { cookie }));
    expect(on.result.succeeded).toEqual([1, 2]);
    expect([1, 2, 3, 4].map((id) => statusOf(h, id))).toEqual([1, 1, 3, 1]);
    expect((await request(h, 'POST', '/api/channels/upstream/999/status', { status: 2 }, { cookie })).status).toBe(404);
  });

  it('测试渠道：返回通过/未通过与耗时；权限不足的提示原样给出', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, '')];
    wire(h, site, {});
    await connect(h, cookie);
    const pass = await json(await request(h, 'POST', '/api/channels/1/test', {}, { cookie }));
    expect(pass.result).toEqual({ passed: true, message: '', timeSeconds: 0.42 });
    expect(h.s.channels.find(1)!.responseTime).toBe(420);
    site.state.testResult = { success: false, message: 'upstream 401', time: 0.2 };
    expect((await json(await request(h, 'POST', '/api/channels/1/test', {}, { cookie }))).result).toMatchObject({ passed: false, message: 'upstream 401' });
    h.upstream.handler = () => jsonRes({ success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: 'channel:operate' }, 403);
    const denied = await request(h, 'POST', '/api/channels/1/test', {}, { cookie });
    expect(denied.status).toBe(502);
    expect((await json(denied)).error).toMatchObject({ code: 'site_scope_denied' });
  });
});

describe('余额归零自动停/恢复渠道', () => {
  async function scenario(opts: { type?: 'newapi' | 'sub2api' } = {}) {
    const { h, cookie, site } = await setup();
    const host = 'a.example.com';
    const up = addUpstream(h, host, opts.type === 'sub2api' ? { type: 'sub2api' } : {});
    const balances: Record<string, number | 'fail'> = { [host]: 10 };
    site.state.channels = [ch(1, `https://${host}`), ch(2, `https://${host}/v1`), ch(3, `https://${host}`, { status: 2 }), ch(4, 'https://other.io'), ch(5, '')];
    wire(h, site, balances);
    await connect(h, cookie);
    await request(h, 'PUT', '/api/settings', { autoDisableAtZero: true }, { cookie });
    const refresh = () => h.s.refresher.run({ force: true });
    return { h, cookie, site, up, balances, refresh, host };
  }

  it('归零停该上游当前启用的渠道并记录；恢复时只恢复本工具停的；全程写审计', async () => {
    const { h, site, balances, refresh, host } = await scenario();
    await refresh(); // 余额 10：什么都不做
    expect([1, 2, 3, 4, 5].map((id) => statusOf(h, id))).toEqual([1, 1, 2, 1, 1]);
    expect(actions(h)).not.toContain('channel.auto_disabled');

    balances[host] = 0;
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([2, 2, 2, 1, 1]); // 其他上游/未归类的渠道不动
    expect(h.s.channels.views().filter((c) => c.autoDisabled).map((c) => c.id)).toEqual([1, 2]); // 3 本就是手动停用的，不是本工具停的
    const batch = site.state.calls.filter((c) => c.url.endsWith('/status/batch'));
    expect(batch).toHaveLength(1);
    expect(JSON.parse(batch[0]!.body!)).toEqual({ ids: [1, 2], status: 2 });
    const disabled = h.db.select().from(auditLog).where(eq(auditLog.action, 'channel.auto_disabled')).all();
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.detail).toContain('1,2');

    // 仍为 0：不重复动作
    const before = site.state.calls.length;
    await refresh();
    expect(site.state.calls.slice(before).filter((c) => c.method !== 'GET')).toHaveLength(0);

    balances[host] = 25;
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([1, 1, 2, 1, 1]); // 3 仍是手动停用
    expect(h.s.channels.views().some((c) => c.autoDisabled)).toBe(false);
    expect(h.db.select().from(auditLog).where(eq(auditLog.action, 'channel.auto_restored')).all()).toHaveLength(1);
  });

  it('归零期间站长在本站改过的渠道不会被恢复动作覆盖', async () => {
    const { h, site, balances, refresh, host } = await scenario();
    balances[host] = 0;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([2, 2]);
    site.state.channels[0]!.status = 1; // 站长手动重新启用了 1
    site.state.channels[1]!.status = 3; // 本站把 2 标为自动禁用
    balances[host] = 5;
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([1, 3, 2, 1, 1]);
    expect(h.s.channels.views().some((c) => c.autoDisabled)).toBe(false); // 记录已清
  });

  it('刷新失败/余额未知绝不动作；开关关闭时不停，但仍会恢复已记录的', async () => {
    const { h, cookie, site, balances, refresh, host } = await scenario();
    balances[host] = 'fail';
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([1, 1, 2, 1, 1]);

    await request(h, 'PUT', '/api/settings', { autoDisableAtZero: false }, { cookie });
    balances[host] = 0;
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([1, 1, 2, 1, 1]);

    await request(h, 'PUT', '/api/settings', { autoDisableAtZero: true }, { cookie });
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([2, 2]);
    balances[host] = 'fail'; // 恢复前的失败刷新：不恢复
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([2, 2]);
    await request(h, 'PUT', '/api/settings', { autoDisableAtZero: false }, { cookie });
    balances[host] = 3;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([1, 1]);
  });

  it('sub2api Key 限额用完同样会触发', async () => {
    const { h, site, balances, refresh, host } = await scenario({ type: 'sub2api' });
    balances[host] = 0;
    await refresh();
    expect(site.state.channels.map((c) => c.status)).toEqual([2, 2, 2, 1, 1]);
    expect(h.db.select().from(auditLog).where(eq(auditLog.action, 'channel.auto_disabled')).get()!.detail).toContain('Key 限额');
  });

  it('批量请求部分生效后报错：补记已被停掉的渠道，保证之后能恢复', async () => {
    const { h, site, balances, refresh, host } = await scenario();
    site.state.batchPartial = 1; // 先停掉第 1 个再返回 500
    balances[host] = 0;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([2, 1]);
    // 回退逐个调用？批量报 500 不是 404，不会回退；渠道 2 仍启用，渠道 1 已被补记
    expect(h.s.channels.views().filter((c) => c.autoDisabled).map((c) => c.id)).toEqual([1]);
    expect(actions(h)).toContain('channel.auto_disable_failed');
    site.state.batchPartial = null;
    balances[host] = 9;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([1, 1]);
  });

  it('本站不可达时本轮跳过，不会误记录；手动操作接管后不再自动恢复', async () => {
    const { h, cookie, site, balances, refresh, host, up } = await scenario();
    const real = h.upstream.handler;
    h.upstream.handler = (c) => (c.url.startsWith(OWN) ? jsonRes({ success: false }, 503) : real(c));
    balances[host] = 0;
    await refresh();
    expect(actions(h)).toContain('channel.auto_skipped');
    expect(site.state.channels.map((c) => c.status)).toEqual([1, 1, 2, 1, 1]);
    h.upstream.handler = real;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 2)).toEqual([2, 2]);

    // 站长在面板里一键启用再一键停用（接管）：记录被清除
    await request(h, 'POST', `/api/channels/upstream/${up.id}/status`, { status: 1 }, { cookie });
    await request(h, 'POST', `/api/channels/upstream/${up.id}/status`, { status: 2 }, { cookie });
    expect(h.s.channels.views().some((c) => c.autoDisabled)).toBe(false);
    balances[host] = 50;
    await refresh();
    expect(site.state.channels.map((c) => c.status).slice(0, 3)).toEqual([2, 2, 2]);
  });

  it('未配置本站时完全不动作', async () => {
    const h = await makeHarness();
    addUpstream(h, 'a.example.com');
    h.s.settings.set('auto_disable_at_zero', 'true');
    h.upstream.handler = (c) => (c.url.endsWith('/api/status') ? jsonRes({ data: {} }) : jsonRes({ success: true, data: { quota: 0 } }));
    await h.s.refresher.run({ force: true });
    expect(h.upstream.calls.every((c) => !c.url.includes('/api/channel'))).toBe(true);
  });
});

describe('调度', () => {
  it('配置本站后 tick 先同步渠道；5 分钟内不重复，到期再同步；未配置不请求', async () => {
    const { h, cookie, site } = await setup();
    wire(h, site, {});
    site.state.channels = [ch(1, '')];
    await h.s.scheduler.tick({ force: true });
    expect(site.state.calls).toHaveLength(0);

    h.s.ownSite.update({ url: OWN, token: OWN_TOKEN });
    await h.s.scheduler.tick({ force: true });
    const n = site.state.calls.length;
    expect(n).toBeGreaterThan(0);
    expect(h.s.channels.views()).toHaveLength(1);
    h.clock.now += 60_000;
    await h.s.scheduler.tick();
    expect(site.state.calls.length).toBe(n);
    h.clock.now += 4 * 60_000;
    site.state.channels = [ch(1, ''), ch(2, '')];
    await h.s.scheduler.tick();
    expect(h.s.channels.views()).toHaveLength(2);
    void cookie;
  });
});
