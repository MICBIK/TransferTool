import type { ChannelService } from './channels.js';
import { BUCKET_MS } from './logAggregate.js';
import {
  computeHealth,
  computeTrend,
  DEFAULT_DEGRADED_RATE,
  DEFAULT_OK_RATE,
  rollupUpstream,
  topErrors,
  type ChannelHealth,
  type HealthThresholds,
  type StatBucket,
  type TrendPoint,
  type UpstreamRollup,
} from './channelHealth.js';
import type { ChannelStatsStore } from './channelStatsStore.js';
import type { Clock } from './clock.js';
import type { ErrorSample } from './logAggregate.js';
import type { IngestStatus, LogIngestor } from './logIngestor.js';
import type { SettingsStore } from './settings.js';
import type { UpstreamService } from './upstreams.js';

const DAY_MS = 24 * 3600_000;

export function healthThresholds(settings: SettingsStore): HealthThresholds {
  const num = (key: 'health_ok_rate' | 'health_degraded_rate', dflt: number) => {
    const n = Number(settings.get(key));
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : dflt;
  };
  const okRate = num('health_ok_rate', DEFAULT_OK_RATE);
  const degradedRate = num('health_degraded_rate', DEFAULT_DEGRADED_RATE);
  // 配置不自洽（降级线不低于正常线）时退回默认，避免“降级”区间消失
  return degradedRate < okRate ? { okRate, degradedRate } : { okRate: DEFAULT_OK_RATE, degradedRate: DEFAULT_DEGRADED_RATE };
}

export interface ChannelHealthView extends ChannelHealth {
  channelId: number;
  upstreamId: number | null;
  enabled: boolean;
}

export interface ChannelDetail extends ChannelHealthView {
  bucketMinutes: number;
  trend: TrendPoint[];
  errors: ErrorSample[];
}

/** 总览用：近 24 小时每小时一格的请求与错误数（最早在前），画状态条 */
export interface HourCell {
  requests: number;
  errors: number;
}

export interface UpstreamHealthView extends UpstreamRollup {
  upstreamId: number;
}

/** 渠道健康的读取与汇总（只读 channel_stats 与渠道缓存）。 */
export class HealthService {
  constructor(
    private readonly deps: {
      stats: ChannelStatsStore;
      channels: ChannelService;
      upstreams: UpstreamService;
      ingestor: LogIngestor;
      settings: SettingsStore;
      clock: Clock;
    },
  ) {}

  private load(now: number): { buckets: Map<number, StatBucket[]>; thresholds: HealthThresholds } {
    return { buckets: this.deps.stats.since(now - DAY_MS - BUCKET_MS), thresholds: healthThresholds(this.deps.settings) };
  }

  private channelViews(now: number, buckets: Map<number, StatBucket[]>, thresholds: HealthThresholds): ChannelHealthView[] {
    return this.deps.channels.rows().map((r) => ({
      channelId: r.channelId,
      upstreamId: r.upstreamId,
      enabled: r.status === 1,
      ...computeHealth(buckets.get(r.channelId) ?? [], now, thresholds),
    }));
  }

  private rollups(views: ChannelHealthView[]): UpstreamHealthView[] {
    return this.deps.upstreams.list().map((u) => ({
      upstreamId: u.id,
      ...rollupUpstream(views.filter((v) => v.upstreamId === u.id)),
    }));
  }

  overview(): { ingest: IngestStatus; missingErrorLogs: boolean; thresholds: HealthThresholds; channels: (ChannelHealthView & { hourly: HourCell[] })[]; upstreams: UpstreamHealthView[] } {
    const now = this.deps.clock();
    const { buckets, thresholds } = this.load(now);
    const views = this.channelViews(now, buckets, thresholds);
    const hourly = (id: number): HourCell[] => computeTrend(buckets.get(id) ?? [], now, 24, 60).map((p) => ({ requests: p.requests, errors: p.errors }));
    // 近 24 小时有消费日志、却一条错误日志都没有入库：多半是本站没开错误日志记录（仅提示，不当作故障）
    const since = now - DAY_MS;
    let requests = 0;
    let errors = 0;
    for (const list of buckets.values()) {
      for (const b of list) {
        if (b.bucketStart + BUCKET_MS > since) {
          requests += b.requests;
          errors += b.errors;
        }
      }
    }
    return {
      ingest: this.deps.ingestor.status(),
      missingErrorLogs: requests > 0 && errors === 0,
      thresholds,
      channels: views.map((v) => ({ ...v, hourly: hourly(v.channelId) })),
      upstreams: this.rollups(views),
    };
  }

  channelDetail(channelId: number, opts: { hours?: number; bucketMinutes?: number } = {}): ChannelDetail | null {
    const row = this.deps.channels.find(channelId);
    if (!row) return null;
    const now = this.deps.clock();
    const { buckets, thresholds } = this.load(now);
    return this.detail(row.channelId, row.upstreamId, row.status === 1, now, buckets, thresholds, opts.bucketMinutes ?? 30, opts.hours ?? 24);
  }

  private detail(channelId: number, upstreamId: number | null, enabled: boolean, now: number, buckets: Map<number, StatBucket[]>, thresholds: HealthThresholds, bucketMinutes: number, hours: number): ChannelDetail {
    const own = buckets.get(channelId) ?? [];
    return {
      channelId,
      upstreamId,
      enabled,
      ...computeHealth(own, now, thresholds),
      bucketMinutes,
      trend: computeTrend(own, now, hours, bucketMinutes),
      errors: topErrors(own, now),
    };
  }

  upstreamDetail(upstreamId: number, bucketMinutes = 30): { rollup: UpstreamHealthView; channels: ChannelDetail[] } | null {
    if (!this.deps.upstreams.find(upstreamId)) return null;
    const now = this.deps.clock();
    const { buckets, thresholds } = this.load(now);
    const rows = this.deps.channels.rowsForUpstream(upstreamId);
    const channels = rows.map((r) => this.detail(r.channelId, r.upstreamId, r.status === 1, now, buckets, thresholds, bucketMinutes, 24));
    return { rollup: { upstreamId, ...rollupUpstream(channels) }, channels };
  }
}
