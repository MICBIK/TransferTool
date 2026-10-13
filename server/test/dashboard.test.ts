import { describe, expect, it } from 'vitest';
import { bucketStartOf } from '../src/services/logAggregate.js';
import { HOUR_MS } from '../src/services/dashboard.js';
import { jsonRes } from './fakeFetch.js';
import { fakeOwnSite, OWN, OWN_TOKEN } from './fakeOwnSite.js';
import { json, login, makeHarness, request } from './helpers.js';

describe('总览看板 API', () => {
  it('需要登录', async () => {
    const h = await makeHarness();
    expect((await request(h, 'GET', '/api/dashboard')).status).toBe(401);
  });

  it('余额按小时取最后值，消耗只计下降，请求按小时与上游汇总', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    const site = fakeOwnSite();
    site.state.channels = [
      { id: 1, name: 'a', base_url: 'https://up.example.com/v1', group: 'default', status: 1 },
      { id: 2, name: 'b', base_url: 'https://other.example.org', group: 'default', status: 1 },
    ];
    h.upstream.handler = (c) => (c.url.startsWith(OWN) ? site.handle(c) : jsonRes({ success: false }, 500));
    const up = h.s.upstreams.create({ name: 'up', type: 'newapi', siteUrl: 'https://up.example.com', credential: 'tok', threshold: 5 } as never);
    expect((await request(h, 'PUT', '/api/settings/own-site', { url: OWN, token: OWN_TOKEN }, { cookie })).status).toBe(200);

    const now = h.clock.now;
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const snap = (ts: number, balanceUsd: number) => h.s.store.insertSnapshot(up.id, ts, { ok: true, balanceUsd, mode: 'newapi' } as never);
    snap(now - 3 * 24 * HOUR_MS, 100); // 不在 1 天区间内
    snap(hour - 2 * HOUR_MS + 1000, 50);
    snap(hour - 2 * HOUR_MS + 2000, 48);
    snap(hour - HOUR_MS + 1000, 45);
    snap(hour - HOUR_MS + 2000, 60); // 充值，不计消耗
    snap(hour + 1, 59);

    const seed = (channelId: number, ts: number, requests: number, errors: number) =>
      h.s.channelStats.apply([{ channelId, bucketStart: bucketStartOf(ts), requests, errors, totalUseTime: 0, samples: [], lastSuccessAt: null }]);
    seed(1, hour - HOUR_MS + 60_000, 10, 1);
    seed(1, hour - HOUR_MS + 600_000, 5, 0);
    seed(2, hour - HOUR_MS + 60_000, 4, 4);
    seed(1, now - 2 * 24 * HOUR_MS, 99, 0); // 区间外

    const body = await json(await request(h, 'GET', '/api/dashboard?days=1', undefined, { cookie }));
    expect(body.since).toBe(now - 24 * HOUR_MS);
    const bal = body.balance.find((b: { upstreamId: number }) => b.upstreamId === up.id).points;
    expect(bal).toEqual([
      [hour - 2 * HOUR_MS, 48],
      [hour - HOUR_MS, 60],
      [hour, 59],
    ]);
    const spend = body.spend.find((b: { upstreamId: number }) => b.upstreamId === up.id).points;
    expect(spend).toEqual([
      [hour - 2 * HOUR_MS, 2],
      [hour - HOUR_MS, 3],
      [hour, 1],
    ]);
    expect(body.traffic).toEqual([[hour - HOUR_MS, 19, 5]]);
    const byUp = Object.fromEntries(body.trafficByUpstream.map((t: { upstreamId: number | null }) => [String(t.upstreamId), t]));
    expect(byUp[String(up.id)]).toMatchObject({ requests: 15, errors: 1 });
    expect(Object.values(byUp).reduce((n, t) => n + (t as { requests: number }).requests, 0)).toBe(19);

    // 不支持的区间按 7 天处理
    const def = await json(await request(h, 'GET', '/api/dashboard?days=3', undefined, { cookie }));
    expect(def.since).toBe(now - 7 * 24 * HOUR_MS);
  });
});
