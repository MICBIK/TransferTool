import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { alerts, auditLog, balanceSnapshots, upstreams } from '../src/db/schema.js';
import { jsonRes } from './fakeFetch.js';
import { configureMail, json, login, makeHarness, request, type Harness } from './helpers.js';

const NEW = { name: '上游A', type: 'newapi', siteUrl: 'https://a.example.com/', credential: 'tok-AAAA-secret', userId: '7', account: 'me@a.com', password: 'pw-secret-1', threshold: 10, emergencyThreshold: 2 };

/** 假 new-api：quota_per_unit=500000，余额由 state.usd 决定。 */
function fakeNewApi(h: Harness, state: { usd: number; fail?: boolean }) {
  h.upstream.handler = (c) => {
    if (c.url.endsWith('/api/status')) return jsonRes({ success: true, data: { quota_per_unit: 500000 } });
    if (state.fail) return jsonRes({ success: false, message: 'down' }, 500);
    return jsonRes({ success: true, data: { quota: Math.round(state.usd * 500000) } });
  };
}

async function setup() {
  const h = await makeHarness();
  const cookie = await login(h);
  return { h, cookie };
}

describe('上游接口', () => {
  it('全部需要登录', async () => {
    const { h } = await setup();
    for (const [m, p] of [['GET', '/api/upstreams'], ['POST', '/api/upstreams'], ['POST', '/api/upstreams/test'], ['POST', '/api/upstreams/refresh'], ['GET', '/api/upstreams/1'], ['GET', '/api/upstreams/1/history'], ['POST', '/api/upstreams/1/secrets/password/copy']] as const) {
      expect((await request(h, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(401);
    }
  });

  it('创建：规范化地址、默认值、敏感字段加密落库且接口只回掩码，创建后立即刷新', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 50 });
    const res = await request(h, 'POST', '/api/upstreams', NEW, { cookie });
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    for (const secret of ['tok-AAAA-secret', 'pw-secret-1', 'me@a.com']) expect(text).not.toContain(secret);
    const { upstream } = await json(res);
    expect(upstream).toMatchObject({
      siteUrl: 'https://a.example.com',
      effectiveTopupUrl: 'https://a.example.com/console/topup',
      matchDomains: ['a.example.com'],
      intervalMinutes: 10,
      rateFactor: 1,
      enabled: true,
      status: 'ok',
      balanceUsd: 50,
      balanceKind: 'wallet',
      secrets: { credential: { set: true, masked: '********' }, password: { set: true } },
    });
    const row = h.db.select().from(upstreams).get()!;
    for (const col of [row.credentialEnc, row.userIdEnc, row.accountEnc, row.passwordEnc]) expect(col).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain('tok-AAAA-secret');
    // 请求头带了解密后的凭证
    expect(h.upstream.calls.find((c) => c.url.endsWith('/user/self'))!.headers.authorization).toBe('Bearer tok-AAAA-secret');
  });

  it('校验：非 http(s) 地址、紧急阈值不小于阈值、未知字段', async () => {
    const { h, cookie } = await setup();
    const bad = (over: object) => request(h, 'POST', '/api/upstreams', { ...NEW, ...over }, { cookie });
    expect((await bad({ siteUrl: 'ftp://a.example.com' })).status).toBe(400);
    expect((await bad({ siteUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ emergencyThreshold: 10 })).status).toBe(400);
    expect((await bad({ topupUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ credential: '' })).status).toBe(400);
    expect((await bad({ evil: 1 })).status).toBe(400);
    expect((await bad({ threshold: -1 })).status).toBe(400);
    expect(h.db.select().from(upstreams).all()).toHaveLength(0);
  });

  it('编辑：敏感字段留空/掩码 = 不修改；改值则重新加密；改域名须同时重填凭证', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 50 });
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    const before = h.db.select().from(upstreams).get()!;

    const r1 = await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { name: '改名', credential: '', password: '********', account: '', threshold: 20 }, { cookie });
    expect(r1.status).toBe(200);
    const after = h.db.select().from(upstreams).get()!;
    expect(after).toMatchObject({ name: '改名', threshold: 20, credentialEnc: before.credentialEnc, passwordEnc: before.passwordEnc, accountEnc: before.accountEnc });

    await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { password: 'new-pw' }, { cookie });
    expect(h.db.select().from(upstreams).get()!.passwordEnc).not.toBe(before.passwordEnc);
    const copied = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/secrets/password/copy`, {}, { cookie }));
    expect(copied.value).toBe('new-pw');

    expect((await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { siteUrl: 'https://other.example.org' }, { cookie })).status).toBe(400);
    // 登录密码会用于自动获取用户 ID，换主机时同样必须重填
    expect((await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { siteUrl: 'https://other.example.org', credential: 'new-token' }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { siteUrl: 'https://other.example.org', credential: 'new-token', password: 'pw2' }, { cookie })).status).toBe(200);
    expect((await request(h, 'PUT', `/api/upstreams/${upstream.id}`, { threshold: 1 }, { cookie })).status).toBe(400); // 紧急阈值 2 ≥ 1
    expect((await request(h, 'PUT', '/api/upstreams/999', { name: 'x' }, { cookie })).status).toBe(404);
  });

  it('没填用户 ID 而站点要求时：用账号密码登录获取一次并加密保存，之后直接使用', async () => {
    const { h, cookie } = await setup();
    let logins = 0;
    h.upstream.handler = (c) => {
      if (c.url.endsWith('/api/status')) return jsonRes({ success: true, data: { quota_per_unit: 500000 } });
      if (c.url.endsWith('/api/user/login')) {
        logins++;
        return jsonRes({ success: true, data: { id: 31 } });
      }
      return c.headers['new-api-user'] === '31' ? jsonRes({ success: true, data: { quota: 2_500_000 } }) : jsonRes({ success: false, message: 'New-Api-User header not provided' }, 401);
    };
    const res = await json(await request(h, 'POST', '/api/upstreams', { ...NEW, userId: '' }, { cookie }));
    expect(res.upstream).toMatchObject({ status: 'low', balanceUsd: 5 }); // 低于阈值 10
    expect(res.upstream.secrets.userId.set).toBe(true);
    const row = h.db.select().from(upstreams).get()!;
    expect(row.userIdEnc).toMatch(/^enc:v1:/);
    await request(h, 'POST', `/api/upstreams/${res.upstream.id}/refresh`, {}, { cookie });
    expect(logins).toBe(1);
  });

  it('状态按最新余额判定：没配 SMTP（提醒发不出去）时低于阈值也显示余额不足', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 1 });
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    expect(upstream).toMatchObject({ status: 'critical', balanceUsd: 1 }); // 紧急阈值 2
  });

  it('手动填写的用户 ID 接受二开站点的字母数字编码，拒绝其他字符', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 1 });
    expect((await request(h, 'POST', '/api/upstreams', { ...NEW, userId: '9B9YQ5' }, { cookie })).status).toBe(201);
    expect(h.upstream.calls.find((c) => c.url.endsWith('/api/user/self'))?.headers['new-api-user']).toBe('9B9YQ5');
    expect((await request(h, 'POST', '/api/upstreams', { ...NEW, userId: 'a b\n' }, { cookie })).status).toBe(400);
  });

  it('复制接口：解密下发并写 audit_log（不含明文）；未设置的字段 404', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 50 });
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    const res = await request(h, 'POST', `/api/upstreams/${upstream.id}/secrets/account/copy`, {}, { cookie, ip: '198.51.100.9' });
    expect((await json(res)).value).toBe('me@a.com');
    const log = h.db.select().from(auditLog).where(eq(auditLog.action, 'upstream.secret_copied')).all();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ target: `upstream:${upstream.id}:account`, ip: '198.51.100.9' });
    expect(JSON.stringify(h.db.select().from(auditLog).all())).not.toMatch(/me@a\.com|pw-secret-1|tok-AAAA/);
    expect((await request(h, 'POST', `/api/upstreams/${upstream.id}/secrets/bogus/copy`, {}, { cookie })).status).toBe(404);

    const { upstream: u2 } = await json(await request(h, 'POST', '/api/upstreams', { ...NEW, name: 'B', account: undefined, password: undefined }, { cookie }));
    expect((await request(h, 'POST', `/api/upstreams/${u2.id}/secrets/password/copy`, {}, { cookie })).status).toBe(404);
  });

  it('测试连接：不落库；编辑时留空凭证沿用库里的；换域名不允许沿用', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 3 });
    const test = await request(h, 'POST', '/api/upstreams/test', { type: 'newapi', siteUrl: 'https://t.example.com', credential: 'tmp-token', userId: '1' }, { cookie });
    expect(await json(test)).toMatchObject({ ok: true, balanceUsd: 3, error: null });
    expect(h.db.select().from(upstreams).all()).toHaveLength(0);
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(0);

    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    h.upstream.calls.length = 0;
    const again = await request(h, 'POST', '/api/upstreams/test', { id: upstream.id, type: 'newapi', siteUrl: 'https://a.example.com', credential: '' }, { cookie });
    expect((await json(again)).ok).toBe(true);
    expect(h.upstream.calls.find((c) => c.url.endsWith('/user/self'))!.headers.authorization).toBe('Bearer tok-AAAA-secret');
    h.upstream.calls.length = 0;
    const moved = await request(h, 'POST', '/api/upstreams/test', { id: upstream.id, type: 'newapi', siteUrl: 'https://evil.example.net', credential: '' }, { cookie });
    expect(moved.status).toBe(400);
    expect(h.upstream.calls).toHaveLength(0);

    fakeNewApi(h, { usd: 0, fail: true });
    const failed = await json(await request(h, 'POST', '/api/upstreams/test', { type: 'newapi', siteUrl: 'https://t.example.com', credential: 'x-token' }, { cookie }));
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
  });

  it('立即刷新、历史曲线、删除级联', async () => {
    const { h, cookie } = await setup();
    const state = { usd: 50 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    h.clock.now += 3600_000;
    state.usd = 49;
    const r = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
    expect(r.upstream.balanceUsd).toBe(49);
    expect(r.summary).toMatchObject({ attempted: 1, succeeded: 1 });
    const hist = await json(await request(h, 'GET', `/api/upstreams/${upstream.id}/history?days=7`, undefined, { cookie }));
    expect(hist.points.map((p: { balanceUsd: number }) => p.balanceUsd)).toEqual([50, 49]);
    expect(hist.threshold).toBe(10);
    const all = await json(await request(h, 'POST', '/api/upstreams/refresh', {}, { cookie }));
    expect(all.upstreams).toHaveLength(1);

    expect((await request(h, 'DELETE', `/api/upstreams/${upstream.id}`, undefined, { cookie })).status).toBe(200);
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(0);
    expect(h.db.select().from(alerts).all()).toHaveLength(0);
    expect((await request(h, 'GET', `/api/upstreams/${upstream.id}`, undefined, { cookie })).status).toBe(404);
  });

  it('停用的上游不被刷新；手动刷新给出提示', async () => {
    const { h, cookie } = await setup();
    fakeNewApi(h, { usd: 50 });
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', { ...NEW, enabled: false }, { cookie }));
    expect(upstream.status).toBe('disabled');
    expect(h.upstream.calls).toHaveLength(0);
    expect((await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie })).status).toBe(400);
    expect((await json(await request(h, 'POST', '/api/upstreams/refresh', {}, { cookie }))).summary.attempted).toBe(0);
  });

  it('设置：提醒间隔与“自动停渠道”开关（默认关）', async () => {
    const { h, cookie } = await setup();
    expect(await json(await request(h, 'GET', '/api/settings', undefined, { cookie }))).toMatchObject({ alertRepeatHours: 6, autoDisableAtZero: false });
    const res = await request(h, 'PUT', '/api/settings', { alertRepeatHours: 12, autoDisableAtZero: true }, { cookie });
    expect(await json(res)).toMatchObject({ alertRepeatHours: 12, autoDisableAtZero: true });
    expect((await request(h, 'PUT', '/api/settings', { alertRepeatHours: 0 }, { cookie })).status).toBe(400);
  });
});

describe('余额提醒（端到端，假 fetch + 假 SMTP）', () => {
  it('静音：期间不发信；到期后按正常间隔继续；「直到余额恢复」在恢复后自动解除', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 50 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    const refresh = () => request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie });
    const mute = (mode: string) => request(h, 'POST', `/api/upstreams/${upstream.id}/mute`, { mode }, { cookie });

    expect((await mute('forever')).status).toBe(400);
    const muted = await json(await mute('1d'));
    expect(muted.upstream.alertMutedUntil).toBe(h.clock.now + 24 * 3600_000);
    h.clock.now += 600_000;
    state.usd = 8;
    await refresh();
    expect(h.sent).toHaveLength(0);
    expect(h.s.upstreams.view(h.s.upstreams.require(upstream.id)).alertLastResult).toBe('已静音，未发送');
    // 静音到期后不立刻补发，按提醒间隔继续
    h.clock.now += 25 * 3600_000;
    await refresh();
    expect(h.sent).toHaveLength(1);
    expect(h.s.upstreams.view(h.s.upstreams.require(upstream.id)).alertMutedUntil).toBeNull();

    // 直到余额恢复：低于阈值期间一直静音，恢复后解除，下次跌破照常提醒
    expect((await json(await mute('recover'))).upstream.alertMutedUntil).toBe(0);
    h.clock.now += 7 * 3600_000;
    state.usd = 1;
    await refresh();
    expect(h.sent).toHaveLength(1);
    state.usd = 100;
    await refresh();
    expect(h.s.upstreams.require(upstream.id).alertMutedUntil).toBeNull();
    state.usd = 8;
    await refresh();
    expect(h.sent).toHaveLength(2);
    expect((await json(await mute('off'))).upstream.alertMutedUntil).toBeNull();
  });

  it('跌破阈值发一封；间隔内不重发；满间隔重发；恢复后再次跌破重新发', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 50 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    expect(h.sent).toHaveLength(0);

    const refresh = () => request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie });
    h.clock.now += 600_000;
    state.usd = 8;
    await refresh();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe('owner@example.com');
    expect(h.sent[0]!.subject).toContain('上游A');
    expect(h.sent[0]!.text).toContain('$8.00');
    expect(h.sent[0]!.text).toContain('$10.00');
    expect(h.sent[0]!.text).toContain('https://a.example.com/console/topup');
    expect(h.sent[0]!.text).not.toContain('tok-AAAA-secret');

    h.clock.now += 3600_000;
    await refresh();
    expect(h.sent).toHaveLength(1);
    h.clock.now += 6 * 3600_000;
    await refresh();
    expect(h.sent).toHaveLength(2);

    state.usd = 100;
    await refresh();
    h.clock.now += 600_000;
    state.usd = 9;
    await refresh();
    expect(h.sent).toHaveLength(3);
  });

  it('查询失败不算跌破；连续 3 次失败标记“余额未知”，不发低余额提醒', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 50, fail: false };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    state.fail = true;
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      h.clock.now += 600_000;
      const r = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
      statuses.push(r.upstream.status);
      expect(r.upstream.lastError).toBeTruthy();
    }
    expect(statuses).toEqual(['ok', 'ok', 'unknown']);
    expect(h.sent).toHaveLength(0);
    const view = (await json(await request(h, 'GET', `/api/upstreams/${upstream.id}`, undefined, { cookie }))).upstream;
    expect(view.balanceUsd).toBeNull();
    // 恢复后失败计数清零
    state.fail = false;
    h.clock.now += 600_000;
    const r = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
    expect(r.upstream).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastError: null });
  });

  it('紧急阈值：low 之后跌破紧急立即再发；之后不再重复', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 50 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    const refresh = async (usd: number, dt = 60_000) => {
      state.usd = usd;
      h.clock.now += dt;
      return json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
    };
    await refresh(8);
    expect(h.sent).toHaveLength(1);
    const r = await refresh(1.5);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.subject).toContain('紧急');
    expect(r.upstream.status).toBe('critical');
    await refresh(1.4, 24 * 3600_000);
    expect(h.sent).toHaveLength(2);
  });

  it('同一轮多个上游跌破合并成一封邮件', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const usd: Record<string, number> = { 'a.example.com': 50, 'b.example.com': 50, 'c.example.com': 50 };
    h.upstream.handler = (c) => {
      if (c.url.endsWith('/api/status')) return jsonRes({ data: { quota_per_unit: 500000 } });
      const host = new URL(c.url).host;
      return jsonRes({ success: true, data: { quota: Math.round(usd[host]! * 500000) } });
    };
    for (const [i, host] of Object.keys(usd).entries()) {
      await request(h, 'POST', '/api/upstreams', { ...NEW, name: `U${i}`, siteUrl: `https://${host}` }, { cookie });
    }
    expect(h.sent).toHaveLength(0);
    usd['a.example.com'] = 5;
    usd['c.example.com'] = 1;
    h.clock.now += 600_000;
    const r = await json(await request(h, 'POST', '/api/upstreams/refresh', {}, { cookie }));
    expect(r.summary.alertsSent).toBe(2);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('U0');
    expect(h.sent[0]!.text).toContain('U2');
    expect(h.sent[0]!.text).not.toContain('U1');
    expect(h.sent[0]!.subject).toContain('紧急');
  });

  it('邮件发送失败不丢提醒：下一轮重试', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 50 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    h.failSend.value = true;
    state.usd = 5;
    h.clock.now += 600_000;
    const r1 = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
    expect(h.sent).toHaveLength(0);
    expect(r1.upstream.alertLastResult).toContain('重试');
    h.failSend.value = false;
    h.clock.now += 60_000;
    await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie });
    expect(h.sent).toHaveLength(1);
  });

  it('邮件包含基于近 24 小时快照的耗尽预估', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    const state = { usd: 20 };
    fakeNewApi(h, state);
    const { upstream } = await json(await request(h, 'POST', '/api/upstreams', NEW, { cookie }));
    expect(upstream.burnBasis).toBe('collecting'); // 只有一个快照
    for (const usd of [16, 12]) {
      state.usd = usd;
      h.clock.now += 3600_000;
      await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie });
    }
    state.usd = 8; // 每小时 -4 => 96 USD/天
    h.clock.now += 3600_000;
    const r = await json(await request(h, 'POST', `/api/upstreams/${upstream.id}/refresh`, {}, { cookie }));
    expect(r.upstream.burnUsdPerDay).toBeCloseTo(96, 3);
    expect(r.upstream.burnBasis).toBe('estimated');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('约 2.0 小时后');
    expect(h.sent[0]!.text).toContain('$96.00/天');
  });

  it('sub2api：订阅制不触发提醒；Key 限额标注为 Key 限额', async () => {
    const { h, cookie } = await setup();
    await configureMail(h, cookie);
    h.upstream.handler = () => jsonRes({ mode: 'unrestricted', balance: 1, subscription: { x: 1 } });
    const sub = { name: 'S', type: 'sub2api', siteUrl: 'https://s.example.com', credential: 'sk-1', threshold: 10 };
    const r = await json(await request(h, 'POST', '/api/upstreams', sub, { cookie }));
    expect(r.upstream).toMatchObject({ status: 'unsupported', balanceUsd: null, effectiveTopupUrl: null });
    expect(h.sent).toHaveLength(0);

    h.upstream.handler = () => jsonRes({ mode: 'quota_limited', remaining: 3 });
    const r2 = await json(await request(h, 'POST', '/api/upstreams', { ...sub, name: 'K' }, { cookie }));
    expect(r2.upstream).toMatchObject({ status: 'low', balanceKind: 'key_limit', balanceUsd: 3 });
    expect(h.sent[0]!.text).toContain('Key 限额');
  });
});
