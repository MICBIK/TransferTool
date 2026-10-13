import { describe, expect, it } from 'vitest';
import { channelStats, settings } from '../src/db/schema.js';
import { BUCKET_MS, bucketStartOf, type BucketAgg } from '../src/services/logAggregate.js';
import { jsonRes } from './fakeFetch.js';
import { fakeOwnSite, OWN, OWN_TOKEN, type FakeChannel, type FakeLog } from './fakeOwnSite.js';
import { json, login, makeHarness, request, type Harness } from './helpers.js';

const ch = (id: number, base_url: string, over: Partial<FakeChannel> = {}): FakeChannel => ({ id, name: `渠道${id}`, base_url, group: 'default', status: 1, ...over });

async function setup() {
  const h = await makeHarness();
  const cookie = await login(h);
  const site = fakeOwnSite();
  h.upstream.handler = (c) => (c.url.startsWith(OWN) ? site.handle(c) : jsonRes({ success: false }, 500));
  return { h, cookie, site };
}

async function connect(h: Harness, cookie: string) {
  expect((await request(h, 'PUT', '/api/settings/own-site', { url: OWN, token: OWN_TOKEN }, { cookie })).status).toBe(200);
}

const upstream = (h: Harness, host: string) => h.s.upstreams.create({ name: host, type: 'newapi', siteUrl: `https://${host}`, credential: 'tok', threshold: 5 } as never);

/** 在 now 之前 agoMin 分钟的桶里直接写入统计 */
function seed(h: Harness, channelId: number, agoMin: number, requests: number, errors: number, extra: Partial<BucketAgg> = {}) {
  const bucketStart = bucketStartOf(h.clock.now - agoMin * 60_000);
  h.s.channelStats.apply([{ channelId, bucketStart, requests, errors, totalUseTime: (requests - errors) * 2, samples: [], lastSuccessAt: requests > errors ? bucketStart + 1000 : null, ...extra }]);
}

const health = async (h: Harness, cookie: string) => json(await request(h, 'GET', '/api/health', undefined, { cookie }));

describe('渠道健康 API', () => {
  it('所有接口需要登录', async () => {
    const { h } = await setup();
    for (const [m, p] of [['GET', '/api/health'], ['POST', '/api/health/ingest'], ['GET', '/api/health/channels/1'], ['GET', '/api/health/upstreams/1']] as const) {
      expect((await request(h, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(401);
    }
  });

  it('按渠道给出状态、1h/24h 成功率、平均耗时、最近成功时间；空闲/正常/降级/异常各一', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [1, 2, 3, 4, 5].map((id) => ch(id, 'https://up.example.com/v1'));
    await connect(h, cookie);
    seed(h, 1, 3, 100, 2); // 98% 正常
    seed(h, 2, 3, 100, 10); // 90% 降级
    seed(h, 3, 3, 100, 40); // 60% 异常
    seed(h, 4, 3, 5, 5); // 30 分钟内全是错误 → 异常
    seed(h, 4, 50, 500, 0);
    seed(h, 1, 600, 100, 50); // 更早，只计入 24h
    const body = await health(h, cookie);
    const by = Object.fromEntries(body.channels.map((c: { channelId: number }) => [c.channelId, c]));
    expect(by[1]).toMatchObject({ status: 'healthy', requests1h: 100, errors1h: 2, requests24h: 200, errors24h: 52, avgLatencyMs1h: 2000, enabled: true });
    expect(by[1].successRate1h).toBeCloseTo(0.98);
    expect(by[1].successRate24h).toBeCloseTo(0.74);
    expect(by[1].lastSuccessAt).toBeGreaterThan(0);
    // 状态条：24 格每小时，最近的在最后
    expect(by[1].hourly).toHaveLength(24);
    expect(by[1].hourly.reduce((n: number, c: { requests: number }) => n + c.requests, 0)).toBe(200);
    expect(by[1].hourly.at(-1)).toEqual({ requests: 100, errors: 2 });
    expect(by[5].hourly.every((c: { requests: number }) => c.requests === 0)).toBe(true);
    expect(by[2].status).toBe('degraded');
    expect(by[3].status).toBe('down');
    expect(by[4].status).toBe('down');
    expect(by[5]).toMatchObject({ status: 'idle', successRate1h: null, avgLatencyMs1h: null, lastSuccessAt: null });
    expect(body.thresholds).toEqual({ okRate: 95, degradedRate: 80 });
  });

  it('上游汇总取启用且有流量渠道里最差的；忽略空闲与已停用', async () => {
    const { h, cookie, site } = await setup();
    const a = upstream(h, 'a.example.com');
    const b = upstream(h, 'b.example.com');
    const c = upstream(h, 'c.example.com');
    site.state.channels = [ch(1, 'https://a.example.com/v1'), ch(2, 'https://a.example.com/v1'), ch(3, 'https://a.example.com/v1'), ch(4, 'https://b.example.com'), ch(5, 'https://b.example.com', { status: 2 })];
    await connect(h, cookie);
    seed(h, 1, 3, 100, 0);
    seed(h, 2, 3, 100, 12); // 降级
    // 3：空闲
    seed(h, 4, 3, 100, 0);
    seed(h, 5, 3, 100, 90); // 异常，但渠道已停用
    const body = await health(h, cookie);
    const up = Object.fromEntries(body.upstreams.map((u: { upstreamId: number }) => [u.upstreamId, u]));
    expect(up[a.id]).toMatchObject({ status: 'degraded', counted: 2, enabledChannels: 3 });
    expect(up[b.id]).toMatchObject({ status: 'healthy', counted: 1, enabledChannels: 1 });
    expect(up[c.id]).toMatchObject({ status: 'idle', counted: 0, enabledChannels: 0 });
  });

  it('提示：24h 内有消费日志却没有任何错误日志 → missingErrorLogs；出现错误日志后消失；没有流量也不提示', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    expect((await health(h, cookie)).missingErrorLogs).toBe(false);
    seed(h, 1, 10, 50, 0);
    expect((await health(h, cookie)).missingErrorLogs).toBe(true);
    seed(h, 1, 20, 10, 1);
    expect((await health(h, cookie)).missingErrorLogs).toBe(false);
  });

  it('渠道趋势（24h）与错误 Top 5；上游详情一次给出名下所有渠道', async () => {
    const { h, cookie, site } = await setup();
    const u = upstream(h, 'a.example.com');
    site.state.channels = [ch(1, 'https://a.example.com'), ch(2, 'https://other.example.com')];
    await connect(h, cookie);
    const samples = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ message: `err-${i}`, count: i }));
    seed(h, 1, 10, 20, 7, { samples });
    seed(h, 1, 300, 10, 5, { samples: [{ message: 'err-1', count: 5 }] });
    seed(h, 1, 305, 10, 4, { samples: [{ message: 'err-5', count: 4 }] }); // err-5 合并后 5+4=9
    const detail = (await json(await request(h, 'GET', '/api/health/channels/1?bucketMinutes=60', undefined, { cookie }))).channel;
    expect(detail.trend).toHaveLength(24);
    expect(detail.trend.reduce((n: number, p: { requests: number }) => n + p.requests, 0)).toBe(40);
    expect(detail.errors).toHaveLength(5);
    expect(detail.errors[0]).toEqual({ message: 'err-5', count: 9 });
    expect(detail.errors.map((e: { message: string }) => e.message)).toEqual(['err-5', 'err-7', 'err-6', 'err-1', 'err-4']) // 跨桶合并：err-1 来自另一个桶;
    const up = await json(await request(h, 'GET', `/api/health/upstreams/${u.id}`, undefined, { cookie }));
    expect(up.channels.map((c: { channelId: number }) => c.channelId)).toEqual([1]);
    expect(up.rollup).toMatchObject({ upstreamId: u.id, status: 'down' });
    expect(up.channels[0].trend).toHaveLength(48);
    expect((await request(h, 'GET', '/api/health/channels/99', undefined, { cookie })).status).toBe(404);
    expect((await request(h, 'GET', '/api/health/upstreams/99', undefined, { cookie })).status).toBe(404);
  });

  it('立即拉取：成功写入聚合；缺少 log:read → 502 且提示权限；未配置 → 400', async () => {
    const { h, cookie, site } = await setup();
    expect((await request(h, 'POST', '/api/health/ingest', {}, { cookie })).status).toBe(400);
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    const now = Math.floor(h.clock.now / 1000);
    const logs: FakeLog[] = [
      { id: 1, created_at: now - 100, type: 2, channel: 1, use_time: 2 },
      { id: 2, created_at: now - 90, type: 5, channel: 1, content: 'upstream 429' },
    ];
    site.state.logs = logs;
    const ok = await request(h, 'POST', '/api/health/ingest', {}, { cookie });
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body.result).toMatchObject({ ok: true, ingested: 2 });
    expect(body.channels.find((c: { channelId: number }) => c.channelId === 1)).toMatchObject({ requests1h: 2, errors1h: 1 });
    site.state.logScopeDenied = true;
    h.clock.now += 60_000;
    const denied = await request(h, 'POST', '/api/health/ingest', {}, { cookie });
    expect(denied.status).toBe(502);
    expect((await json(denied)).error.message).toBe('本站令牌缺少权限：log:read');
    expect((await health(h, cookie)).ingest.lastError).toBe('本站令牌缺少权限：log:read');
  });

  it('断开本站会清除日志游标', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    await h.s.logIngestor.run();
    expect(h.db.select().from(settings).all().some((r) => r.key === 'log_ingest_state')).toBe(true);
    expect((await request(h, 'PUT', '/api/settings/own-site', { url: '' }, { cookie })).status).toBe(200);
    expect(h.db.select().from(settings).all().some((r) => r.key === 'log_ingest_state')).toBe(false);
  });
});

describe('健康阈值设置', () => {
  it('默认 95/80，可调并生效；降级线必须低于正常线；非法值被拒绝', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    const get = async () => json(await request(h, 'GET', '/api/settings', undefined, { cookie }));
    expect(await get()).toMatchObject({ healthOkRate: 95, healthDegradedRate: 80 });
    seed(h, 1, 3, 100, 8); // 92%
    expect((await health(h, cookie)).channels[0].status).toBe('degraded');
    expect((await request(h, 'PUT', '/api/settings', { healthOkRate: 90 }, { cookie })).status).toBe(200);
    expect((await health(h, cookie)).channels[0].status).toBe('healthy');
    expect((await request(h, 'PUT', '/api/settings', { healthDegradedRate: 95 }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { healthOkRate: 101 }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { healthOkRate: 70 }, { cookie })).status).toBe(400); // 70 ≤ 当前降级线 80
    expect(await get()).toMatchObject({ healthOkRate: 90, healthDegradedRate: 80 });
    expect((await request(h, 'PUT', '/api/settings', { healthOkRate: 99, healthDegradedRate: 97 }, { cookie })).status).toBe(200);
    expect((await health(h, cookie)).channels[0].status).toBe('down');
  });
});

describe('调度器：日志拉取', () => {
  it('渠道同步之后拉日志；5 分钟内不重复；错误只记录不抛出', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    site.state.calls.length = 0;
    const logSec = Math.floor(h.clock.now / 1000) - 100;
    site.state.logs = [{ id: 1, created_at: logSec, type: 2, channel: 1, use_time: 1 }];
    await h.s.scheduler.tick({ force: true });
    const order = site.state.calls.map((c) => new URL(c.url).pathname).filter((p, i, a) => p !== a[i - 1]);
    expect(order.slice(0, 2)).toEqual(['/api/channel/', '/api/log/']);
    expect(h.db.select().from(channelStats).all()).toHaveLength(1);

    const count = () => site.state.calls.filter((c) => c.url.includes('/api/log/')).length;
    const before = count();
    h.clock.now += 60_000;
    await h.s.scheduler.tick();
    expect(count()).toBe(before); // 不到 5 分钟
    h.clock.now += 4 * 60_000;
    await h.s.scheduler.tick();
    expect(count()).toBeGreaterThan(before);

    site.state.logScopeDenied = true;
    h.clock.now += 5 * 60_000;
    await expect(h.s.scheduler.tick()).resolves.toBeUndefined();
    expect(h.s.logIngestor.status().lastError).toBe('本站令牌缺少权限：log:read');
  });

  it('日志拉取不重叠：上一轮没结束时，tick 与手动触发都不会并发发请求', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let peak = 0;
    h.upstream.handler = async (c) => {
      if (!c.url.includes('/api/log/')) return site.handle(c);
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return site.handle(c);
    };
    const first = h.s.scheduler.tick({ force: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.s.logIngestor.busy).toBe(true);
    await h.s.scheduler.tick({ force: true }); // 上一个 tick 还在进行：直接跳过
    const manual = h.s.logIngestor.run(); // 手动触发：排队
    release();
    await Promise.all([first, manual]);
    expect(peak).toBe(1);
  });

  it('页数用完没追平时，下一个节拍继续（不必等 5 分钟）', async () => {
    const { h, cookie, site } = await setup();
    site.state.channels = [ch(1, 'https://a.example.com')];
    await connect(h, cookie);
    h.s.logIngestor.backlog = true;
    h.s.logIngestor.lastAttemptAt = h.clock.now;
    site.state.calls.length = 0;
    await h.s.scheduler.tick();
    expect(site.state.calls.some((c) => c.url.includes('/api/log/'))).toBe(true);
  });

  it('每日清理 30 天前的统计桶', async () => {
    const { h } = await setup();
    const old = h.clock.now - 31 * 86400_000;
    const fresh = h.clock.now - 29 * 86400_000;
    h.s.channelStats.apply([old, fresh].map((t) => ({ channelId: 1, bucketStart: bucketStartOf(t), requests: 1, errors: 0, totalUseTime: 0, samples: [], lastSuccessAt: null })));
    await h.s.scheduler.tick();
    expect(h.db.select().from(channelStats).all().map((r) => r.bucketStart)).toEqual([bucketStartOf(fresh)]);
    expect(BUCKET_MS).toBe(300_000);
  });

  it('本站未配置时不拉日志', async () => {
    const h = await makeHarness();
    await h.s.scheduler.tick({ force: true });
    expect(h.upstream.calls).toHaveLength(0);
  });
});
