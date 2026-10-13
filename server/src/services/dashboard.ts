import type { BalanceStore } from './balanceStore.js';
import type { ChannelService } from './channels.js';
import type { ChannelStatsStore } from './channelStatsStore.js';
import type { Clock } from './clock.js';
import type { UpstreamService } from './upstreams.js';

export const HOUR_MS = 3600_000;
export const DASHBOARD_DAYS = [1, 7, 30] as const;
export type DashboardDays = (typeof DASHBOARD_DAYS)[number];

/** [小时起点(毫秒), 数值] */
export type HourPoint = [number, number];

export interface DashboardSeries {
  now: number;
  since: number;
  /** 每个上游：每小时最后一次成功快照的余额 */
  balance: { upstreamId: number; points: HourPoint[] }[];
  /** 每个上游：每小时的消耗（余额下降量之和，充值造成的上升不计） */
  spend: { upstreamId: number; points: HourPoint[] }[];
  /** 本站全部渠道：每小时 [小时起点, 请求数, 失败数] */
  traffic: [number, number, number][];
  /** 区间内按上游汇总的请求与失败；upstreamId 为 null 表示未归类渠道 */
  trafficByUpstream: { upstreamId: number | null; requests: number; errors: number }[];
}

const hourOf = (ts: number) => Math.floor(ts / HOUR_MS) * HOUR_MS;

/** 总览看板用的时间序列，只读已有的余额快照与渠道统计，不发起任何外部请求。 */
export class DashboardService {
  constructor(
    private readonly deps: {
      store: BalanceStore;
      stats: ChannelStatsStore;
      channels: ChannelService;
      upstreams: UpstreamService;
      clock: Clock;
    },
  ) {}

  series(days: DashboardDays): DashboardSeries {
    const now = this.deps.clock();
    const since = now - days * 24 * HOUR_MS;
    const balance: DashboardSeries['balance'] = [];
    const spend: DashboardSeries['spend'] = [];
    for (const u of this.deps.upstreams.list()) {
      // 多取一小时，区间开头的第一段下降也能算进消耗
      const points = this.deps.store.points(u.id, since - HOUR_MS);
      const last = new Map<number, number>();
      const used = new Map<number, number>();
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        if (p.ts >= since) last.set(hourOf(p.ts), p.balanceUsd);
        const prev = points[i - 1];
        if (prev && p.ts >= since && p.balanceUsd < prev.balanceUsd) {
          const h = hourOf(p.ts);
          used.set(h, (used.get(h) ?? 0) + (prev.balanceUsd - p.balanceUsd));
        }
      }
      balance.push({ upstreamId: u.id, points: [...last] });
      spend.push({ upstreamId: u.id, points: [...used].map(([h, v]) => [h, Math.round(v * 1e4) / 1e4]) });
    }

    const upstreamOf = new Map(this.deps.channels.rows().map((r) => [r.channelId, r.upstreamId]));
    const hourly = new Map<number, [number, number]>();
    const byUpstream = new Map<number | null, { requests: number; errors: number }>();
    for (const [channelId, buckets] of this.deps.stats.since(since - 1)) {
      const upstreamId = upstreamOf.get(channelId) ?? null;
      for (const b of buckets) {
        if (b.bucketStart < since || b.requests === 0) continue;
        const h = hourOf(b.bucketStart);
        const cur = hourly.get(h) ?? [0, 0];
        cur[0] += b.requests;
        cur[1] += b.errors;
        hourly.set(h, cur);
        const agg = byUpstream.get(upstreamId) ?? { requests: 0, errors: 0 };
        agg.requests += b.requests;
        agg.errors += b.errors;
        byUpstream.set(upstreamId, agg);
      }
    }
    return {
      now,
      since,
      balance,
      spend,
      traffic: [...hourly].sort((a, b) => a[0] - b[0]).map(([h, [r, e]]) => [h, r, e]),
      trafficByUpstream: [...byUpstream].map(([upstreamId, v]) => ({ upstreamId, ...v })),
    };
  }
}
