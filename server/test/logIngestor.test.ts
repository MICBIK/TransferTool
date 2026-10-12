import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { channelStats, settings } from '../src/db/schema.js';
import { BUCKET_MS } from '../src/services/logAggregate.js';
import { LAG_SECONDS, type IngestState } from '../src/services/logIngestor.js';
import { buildServices } from '../src/services/index.js';
import { fakeFetch, jsonRes, type RecordedCall } from './fakeFetch.js';
import { fakeOwnSite, OWN, OWN_TOKEN, type FakeLog } from './fakeOwnSite.js';
import { makeHarness, testConfig } from './helpers.js';
import { openDatabase } from '../src/db/client.js';

const NOW_SEC = 1_700_000_000;

/** 用较小的分页/页数上限搭建环境，便于覆盖“窗口内日志超过单轮上限”的分段逻辑。 */
async function setup(opts: { pageSize?: number; pageBudget?: number; logPageSize?: number; logArray?: boolean } = {}) {
  const { db } = openDatabase(':memory:');
  const clock = { now: NOW_SEC * 1000 };
  const site = fakeOwnSite({ logPageSize: opts.logPageSize, logArray: opts.logArray });
  const hook = { handler: site.handle as (c: RecordedCall) => Response | Promise<Response> };
  const ff = fakeFetch((c) => hook.handler(c));
  const s = buildServices(testConfig(), db, { fetch: ff.fetch, clock: () => clock.now, hashIterations: 1000, logIngest: { pageSize: opts.pageSize, pageBudget: opts.pageBudget } });
  s.ownSite.update({ url: OWN, token: OWN_TOKEN });
  return { s, db, site, clock, hook, calls: ff.calls };
}

let nextId = 1;
const L = (created_at: number, type: 2 | 5, channel: number, over: Partial<FakeLog> = {}): FakeLog => ({ id: nextId++, created_at, type, channel, use_time: 1, model_name: 'm', quota: 5, ...over });

function totals(db: ReturnType<typeof openDatabase>['db'], channelId?: number) {
  const rows = db.select().from(channelStats).all().filter((r) => channelId === undefined || r.channelId === channelId);
  return { requests: rows.reduce((n, r) => n + r.requests, 0), errors: rows.reduce((n, r) => n + r.errors, 0), useTime: rows.reduce((n, r) => n + r.totalUseTime, 0), buckets: rows.length };
}
const state = (db: ReturnType<typeof openDatabase>['db']): IngestState => JSON.parse(db.select().from(settings).where(eq(settings.key, 'log_ingest_state')).get()!.value) as IngestState;

describe('日志增量拉取', () => {
  it('首次只回溯 1 小时，窗口右端 = 现在 - 30 秒；游标落库', async () => {
    const { s, db, site, calls } = await setup();
    site.state.logs = [L(NOW_SEC - 3700, 2, 1), L(NOW_SEC - 3500, 2, 1), L(NOW_SEC - 100, 5, 1, { content: 'boom' }), L(NOW_SEC - 10, 2, 1)];
    const r = await s.logIngestor.run();
    expect(r).toMatchObject({ ok: true, ingested: 2, backlog: false });
    expect(totals(db)).toMatchObject({ requests: 2, errors: 1 });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('start_timestamp')).toBe(String(NOW_SEC - 3600));
    expect(u.searchParams.get('end_timestamp')).toBe(String(NOW_SEC - LAG_SECONDS));
    expect(state(db).cursor).toBe(NOW_SEC - LAG_SECONDS + 1);
    expect(s.logIngestor.status()).toMatchObject({ lastError: null, backlog: false });
  });

  it('增量：不重复也不遗漏，包括恰在边界秒的日志', async () => {
    const { s, db, site, clock } = await setup();
    site.state.logs = [L(NOW_SEC - 60, 2, 1), L(NOW_SEC - LAG_SECONDS, 2, 1)];
    await s.logIngestor.run();
    expect(totals(db).requests).toBe(2);
    await s.logIngestor.run(); // 没有新日志
    expect(totals(db).requests).toBe(2);
    clock.now += 5 * 60_000;
    site.state.logs.push(L(NOW_SEC - LAG_SECONDS + 1, 2, 1), L(NOW_SEC + 100, 5, 1), L(NOW_SEC + 200, 2, 2));
    await s.logIngestor.run();
    expect(totals(db)).toMatchObject({ requests: 5, errors: 1 });
    expect(totals(db, 2).requests).toBe(1);
  });

  it('同一桶多次合并相加；错误样本合并后保留 Top 5', async () => {
    const { s, db, site, clock } = await setup();
    const bucket = Math.floor(NOW_SEC / 300) * 300; // 现在所在的桶：NOW-200 … NOW+100
    site.state.logs = [L(bucket + 10, 5, 1, { content: 'e1' }), L(bucket + 11, 5, 1, { content: 'e1' }), L(bucket + 12, 2, 1)];
    await s.logIngestor.run();
    clock.now += 100_000; // 仍在同一个桶内的后续日志，下一轮才进入窗口
    site.state.logs.push(L(bucket + 180, 5, 1, { content: 'e1' }), L(bucket + 181, 5, 1, { content: 'e2' }), L(bucket + 182, 2, 1));
    await s.logIngestor.run();
    const rows = db.select().from(channelStats).where(eq(channelStats.channelId, 1)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucketStart: bucket * 1000, requests: 6, errors: 4 });
    expect(JSON.parse(rows[0]!.errorSamples)).toEqual([{ message: 'e1', count: 3 }, { message: 'e2', count: 1 }]);
  });

  it('消费日志的耗时与最近成功时间；不保存原始日志与敏感字段', async () => {
    const { s, db, site } = await setup();
    site.state.logs = [L(NOW_SEC - 100, 2, 1, { use_time: 3, token_name: 'name-SECRET', ip: '8.8.8.8' }), L(NOW_SEC - 90, 2, 1, { use_time: 5 }), L(NOW_SEC - 80, 5, 1, { use_time: 99, content: `fail for ${OWN_TOKEN}` })];
    await s.logIngestor.run();
    const [row] = db.select().from(channelStats).all();
    expect(row).toMatchObject({ requests: 3, errors: 1, totalUseTime: 8, lastSuccessAt: (NOW_SEC - 90) * 1000 });
    const dump = JSON.stringify({ stats: db.select().from(channelStats).all(), settings: db.select().from(settings).all() });
    for (const needle of ['name-SECRET', '8.8.8.8', OWN_TOKEN]) expect(dump).not.toContain(needle);
    expect(row!.errorSamples).toContain('fail for ***');
  });

  it('窗口内日志超过单轮上限：分段拉取，不漏不重，逐轮追平', async () => {
    // 每页 10 条、单段最多 3 页（30 条/类）。3000 秒窗口内放 200 条消费 + 70 条错误。
    const { s, db, site, clock } = await setup({ pageSize: 10, pageBudget: 3 });
    const start = NOW_SEC - 3000;
    for (let i = 0; i < 200; i++) site.state.logs.push(L(start + 5 + Math.floor(i * 14.5), 2, 1 + (i % 3), { use_time: 2 }));
    for (let i = 0; i < 70; i++) site.state.logs.push(L(start + 20 + i * 40, 5, 1 + (i % 3), { content: `err ${i % 4}` }));
    // 同一秒挤很多条，覆盖分段边界
    for (let i = 0; i < 12; i++) site.state.logs.push(L(start + 1500, 2, 1), L(start + 1500, 5, 2, { content: 'same-second' }));
    const expectConsume = site.state.logs.filter((l) => l.type === 2).length;
    const expectError = site.state.logs.filter((l) => l.type === 5).length;

    let runs = 0;
    let first = true;
    for (;;) {
      const r = await s.logIngestor.run();
      expect(r.ok).toBe(true);
      runs++;
      if (first) {
        first = false;
        expect(r.backlog).toBe(true); // 一轮追不平
      }
      if (!r.backlog) break;
      expect(runs).toBeLessThan(60);
    }
    expect(runs).toBeGreaterThan(1);
    const t = totals(db);
    expect(t.requests).toBe(expectConsume + expectError);
    expect(t.errors).toBe(expectError);
    expect(t.useTime).toBe(site.state.logs.filter((l) => l.type === 2).reduce((n, l) => n + (l.use_time ?? 0), 0));
    // 按渠道也对得上
    for (const ch of [1, 2, 3]) {
      const mine = site.state.logs.filter((l) => l.channel === ch);
      expect(totals(db, ch).requests, `channel ${ch}`).toBe(mine.length);
    }
    // 追平后再跑一轮不会重复计数
    clock.now += 5 * 60_000;
    await s.logIngestor.run();
    expect(totals(db).requests).toBe(expectConsume + expectError);
    expect(state(db).cursor).toBe(NOW_SEC + 300 - LAG_SECONDS + 1);
  });

  it('分段后的单次拉取不超过页数上限（有 total 时先对半切分，不浪费请求）', async () => {
    const { s, site, calls } = await setup({ pageSize: 10, pageBudget: 3 });
    for (let i = 0; i < 100; i++) site.state.logs.push(L(NOW_SEC - 3000 + i * 20, 2, 1));
    await s.logIngestor.run();
    const pagesByWindow = new Map<string, number>();
    for (const c of calls) {
      const q = new URL(c.url).searchParams;
      const key = `${q.get('type')}:${q.get('start_timestamp')}-${q.get('end_timestamp')}`;
      pagesByWindow.set(key, Math.max(pagesByWindow.get(key) ?? 0, Number(q.get('p'))));
    }
    expect(Math.max(...pagesByWindow.values())).toBeLessThanOrEqual(3);
  });

  it('响应是纯数组（没有 total）时也能分段：超限的拉取被丢弃并缩小分段，最终不漏不重', async () => {
    const { s, db, site } = await setup({ pageSize: 10, pageBudget: 3, logArray: true });
    for (let i = 0; i < 150; i++) site.state.logs.push(L(NOW_SEC - 3000 + i * 19, i % 5 === 0 ? 5 : 2, 1 + (i % 2), { content: 'x' }));
    for (let n = 0; n < 80; n++) {
      const r = await s.logIngestor.run();
      expect(r.ok).toBe(true);
      if (!r.backlog) break;
    }
    expect(totals(db)).toMatchObject({ requests: 150, errors: 30 });
  });

  it('本站每页返回的条数少于请求的 page_size 时，仍能拉全（以 total 为准）', async () => {
    const { s, db, site } = await setup({ pageSize: 100, pageBudget: 50, logPageSize: 7 });
    for (let i = 0; i < 40; i++) site.state.logs.push(L(NOW_SEC - 1000 + i, 2, 1));
    const r = await s.logIngestor.run();
    expect(r).toMatchObject({ ok: true, ingested: 40 });
    expect(totals(db).requests).toBe(40);
  });

  it('游标被回拨时，按边界秒内已入库的 id 去重', async () => {
    const { s, db, site } = await setup();
    site.state.logs = [L(NOW_SEC - 100, 2, 1), L(NOW_SEC - LAG_SECONDS, 2, 1), L(NOW_SEC - LAG_SECONDS, 5, 1, { content: 'b' })];
    await s.logIngestor.run();
    expect(totals(db).requests).toBe(3);
    const st = state(db);
    expect(st.boundary?.sec).toBe(NOW_SEC - LAG_SECONDS);
    // 回拨到边界秒本身（等价于本站把区间当成半开/重叠处理）
    db.update(settings).set({ value: JSON.stringify({ ...st, cursor: NOW_SEC - LAG_SECONDS }) }).where(eq(settings.key, 'log_ingest_state')).run();
    await s.logIngestor.run();
    expect(totals(db).requests).toBe(3);
  });

  it('翻页期间出现的重复条目只计一次', async () => {
    const { s, db, site, hook } = await setup({ pageSize: 2 });
    site.state.logs = [L(NOW_SEC - 100, 2, 1), L(NOW_SEC - 99, 2, 1), L(NOW_SEC - 98, 2, 1)];
    const dupe = site.state.logs[1]!;
    // 第二页多返回第一页里已经出现过的一条（模拟翻页期间的偏移）
    hook.handler = async (c) => {
      const res = site.handle(c);
      if (!c.url.includes('p=2')) return res;
      const b = (await res.json()) as { data: { items: unknown[] } };
      return jsonRes({ ...b, data: { ...b.data, items: [dupe, ...b.data.items] } });
    };
    await s.logIngestor.run();
    expect(totals(db).requests).toBe(3);
  });

  it('失败（缺 log:read、站点不可达、success:false）只记录错误，游标不动，下轮自动恢复', async () => {
    const { s, db, site, clock } = await setup();
    site.state.logs = [L(NOW_SEC - 100, 2, 1)];
    site.state.logScopeDenied = true;
    const r1 = await s.logIngestor.run();
    expect(r1).toMatchObject({ ok: false, error: '本站令牌缺少权限：log:read' });
    expect(s.logIngestor.status().lastError).toBe('本站令牌缺少权限：log:read');
    expect(db.select().from(settings).where(eq(settings.key, 'log_ingest_state')).get()).toBeUndefined();
    expect(totals(db).requests).toBe(0);
    site.state.logScopeDenied = false;
    site.state.logBusinessError = true;
    expect((await s.logIngestor.run()).error).toBe('无权查看日志');
    site.state.logBusinessError = false;
    clock.now += 60_000;
    expect(await s.logIngestor.run()).toMatchObject({ ok: true, ingested: 1 });
    expect(s.logIngestor.status().lastError).toBeNull();
    expect(totals(db).requests).toBe(1);
  });

  it('分段中途失败：已提交的分段保留，游标停在最后完整入库的位置，恢复后补齐', async () => {
    const { s, db, site, hook } = await setup({ pageSize: 10, pageBudget: 3 });
    for (let i = 0; i < 120; i++) site.state.logs.push(L(NOW_SEC - 3000 + i * 24, 2, 1));
    let broken = true;
    // 第一个分段提交之后，后续的日志请求全部失败
    hook.handler = (c) => (c.url.includes('/api/log/') && broken && totals(db).requests > 0 ? jsonRes({ success: false, message: 'boom' }, 500) : site.handle(c));
    const r1 = await s.logIngestor.run();
    expect(r1.ok).toBe(false);
    expect(r1.chunks).toBeGreaterThan(0); // 失败前有分段已提交
    const partial = totals(db).requests;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(120);
    // 游标之前的日志已全部入库，之后的一条都没有
    const cursor = state(db).cursor;
    expect(partial).toBe(site.state.logs.filter((l) => l.created_at < cursor).length);
    broken = false;
    for (let i = 0; i < 50; i++) if (!(await s.logIngestor.run()).backlog) break;
    expect(totals(db).requests).toBe(120);
  });

  it('Keep 30 天：超过 30 天的桶被清理', async () => {
    const { s, db, clock } = await setup();
    s.channelStats.apply([{ channelId: 1, bucketStart: clock.now - 31 * 86400_000, requests: 1, errors: 0, totalUseTime: 0, samples: [], lastSuccessAt: null }, { channelId: 1, bucketStart: clock.now - 29 * 86400_000, requests: 1, errors: 0, totalUseTime: 0, samples: [], lastSuccessAt: null }]);
    expect(s.channelStats.cleanup(clock.now - 30 * 86400_000)).toBe(1);
    expect(totals(db).buckets).toBe(1);
  });

  it('桶 5 分钟对齐', async () => {
    const { s, db, site } = await setup();
    site.state.logs = [L(NOW_SEC - 100, 2, 1), L(NOW_SEC - 400, 2, 1)];
    await s.logIngestor.run();
    for (const r of db.select().from(channelStats).all()) expect(r.bucketStart % BUCKET_MS).toBe(0);
  });

  it('未配置本站：不请求，也不算错误', async () => {
    const h = await makeHarness();
    expect(h.s.logIngestor.configured).toBe(false);
    expect(await h.s.logIngestor.run()).toMatchObject({ ok: false });
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.s.logIngestor.status().lastError).toBeNull();
  });
});
