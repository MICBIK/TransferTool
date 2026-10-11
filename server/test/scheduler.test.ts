import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { balanceSnapshots, upstreams } from '../src/db/schema.js';
import { SNAPSHOT_RETENTION_MS } from '../src/services/balanceStore.js';
import { jsonRes } from './fakeFetch.js';
import { makeHarness, type Harness } from './helpers.js';

afterEach(() => vi.useRealTimers());

function addUpstreams(h: Harness, n: number, over: Partial<Parameters<Harness['s']['upstreams']['create']>[0]> = {}) {
  for (let i = 0; i < n; i++) {
    h.s.upstreams.create({ name: `U${i}`, type: 'newapi', siteUrl: `https://u${i}.example.com`, credential: `tok-${i}`, threshold: 5, ...over });
  }
}

const quotaRes = (usd: number) => jsonRes({ success: true, data: { quota: usd * 500000 } });

describe('刷新器与调度器', () => {
  it('全局并发上限 5', async () => {
    const h = await makeHarness();
    addUpstreams(h, 12);
    let inFlight = 0;
    let peak = 0;
    h.upstream.handler = async (c) => {
      if (c.url.endsWith('/api/status')) return jsonRes({ data: { quota_per_unit: 500000 } });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return quotaRes(10);
    };
    const summary = await h.s.refresher.run({ force: true });
    expect(summary).toMatchObject({ attempted: 12, succeeded: 12 });
    expect(peak).toBe(5);
  });

  it('按各自的刷新间隔判定到期', async () => {
    const h = await makeHarness();
    addUpstreams(h, 1, { intervalMinutes: 10 });
    h.upstream.handler = () => quotaRes(10);
    expect((await h.s.refresher.run()).attempted).toBe(1); // 从未检查过
    h.clock.now += 5 * 60_000;
    expect((await h.s.refresher.run()).attempted).toBe(0);
    h.clock.now += 5 * 60_000;
    expect((await h.s.refresher.run()).attempted).toBe(1);
  });

  it('run 之间串行，不重叠；忙时调度 tick 直接跳过', async () => {
    const h = await makeHarness();
    addUpstreams(h, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let overlapped = false;
    let userSelfCalls = 0;
    h.upstream.handler = async (c) => {
      if (c.url.endsWith('/api/status')) return jsonRes({ data: {} });
      userSelfCalls++;
      active++;
      if (active > 1) overlapped = true;
      await gate;
      active--;
      return quotaRes(10);
    };
    const first = h.s.refresher.run({ force: true });
    await vi.waitFor(() => expect(userSelfCalls).toBe(1));
    expect(h.s.refresher.busy).toBe(true);
    await h.s.scheduler.tick(); // 忙：跳过
    const second = h.s.refresher.run({ force: true }); // 手动：排队等待
    release();
    await Promise.all([first, second]);
    expect(userSelfCalls).toBe(2);
    expect(overlapped).toBe(false);
    expect(h.s.refresher.busy).toBe(false);
  });

  it('启动立即跑一次，之后每分钟 tick；stop 清除定时器并等待收尾', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await makeHarness();
    addUpstreams(h, 1, { intervalMinutes: 1 });
    let calls = 0;
    h.upstream.handler = (c) => {
      if (!c.url.endsWith('/api/status')) calls++;
      return quotaRes(10);
    };
    h.s.scheduler.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    h.clock.now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(calls).toBe(2));
    await h.s.scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    h.clock.now += 120_000;
    await vi.advanceTimersByTimeAsync(180_000);
    await h.s.scheduler.tick({ force: true });
    expect(calls).toBe(2);
  });

  it('stop 会中止在途请求、等待收尾，并丢弃半成品结果；之后不再刷新', async () => {
    const h = await makeHarness();
    addUpstreams(h, 1);
    let started = false;
    h.upstream.handler = (c) => {
      if (c.url.endsWith('/api/status')) return jsonRes({ data: {} });
      started = true;
      return new Promise<Response>((_res, rej) => c.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    };
    const p = h.s.refresher.run({ force: true });
    await vi.waitFor(() => expect(started).toBe(true));
    await h.s.scheduler.stop();
    expect(await p).toMatchObject({ attempted: 0 });
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(0);
    expect(h.s.refresher.busy).toBe(false);
    expect((await h.s.refresher.run({ force: true })).attempted).toBe(0);
  });

  it('每日清理 90 天前的快照，且只清一次/天', async () => {
    const h = await makeHarness();
    addUpstreams(h, 1);
    h.upstream.handler = () => quotaRes(10);
    await h.s.refresher.run({ force: true });
    const now = h.clock.now;
    const id = h.s.upstreams.list()[0]!.id;
    h.db.insert(balanceSnapshots).values({ upstreamId: id, ts: now - SNAPSHOT_RETENTION_MS - 1, balanceUsd: 1, mode: 'newapi', ok: true }).run();
    h.db.insert(balanceSnapshots).values({ upstreamId: id, ts: now - SNAPSHOT_RETENTION_MS + 1000, balanceUsd: 1, mode: 'newapi', ok: true }).run();
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(3);
    await h.s.scheduler.tick();
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(2);
    // 同一天内不会再清理
    h.db.insert(balanceSnapshots).values({ upstreamId: id, ts: now - SNAPSHOT_RETENTION_MS - 5, balanceUsd: 1, mode: 'newapi', ok: true }).run();
    await h.s.scheduler.tick();
    expect(h.db.select().from(balanceSnapshots).all()).toHaveLength(3);
    h.clock.now += 24 * 3600_000;
    await h.s.scheduler.tick();
    expect(h.db.select().from(balanceSnapshots).all().every((r) => r.ts >= h.clock.now - SNAPSHOT_RETENTION_MS)).toBe(true);
  });

  it('无法解密的凭证只让该上游失败，不影响其他上游', async () => {
    const h = await makeHarness();
    addUpstreams(h, 2);
    h.upstream.handler = () => quotaRes(10);
    h.db.update(upstreams).set({ credentialEnc: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }).run();
    const first = h.s.upstreams.list()[0]!;
    h.db.update(upstreams).set({ credentialEnc: h.s.upstreams.list()[1]!.credentialEnc }).where(eq(upstreams.id, first.id)).run();
    const summary = await h.s.refresher.run({ force: true });
    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(2);
  });
});
