import { BUCKET_MS, mergeSamples, parseSamples, type ErrorSample } from './logAggregate.js';

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'idle';

export const HEALTH_LABELS: Record<HealthStatus, string> = { healthy: '正常', degraded: '降级', down: '异常', idle: '空闲' };
export const DEFAULT_OK_RATE = 95;
export const DEFAULT_DEGRADED_RATE = 80;
const HOUR_MS = 3600_000;
const HALF_HOUR_MS = 30 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** 阈值，百分数：成功率 ≥ okRate 为正常，≥ degradedRate 为降级，其余为异常。 */
export interface HealthThresholds {
  okRate: number;
  degradedRate: number;
}

export interface WindowCounts {
  requests: number;
  errors: number;
}

/**
 * 状态判定（纯函数）：
 *  - 近 1 小时无请求 → 空闲
 *  - 近 30 分钟有请求但一次成功都没有 → 异常（即使 1 小时成功率不低）
 *  - 否则按近 1 小时成功率：≥ okRate 正常；≥ degradedRate 降级；其余异常
 */
export function classifyHealth(h1: WindowCounts, m30: WindowCounts, t: HealthThresholds): HealthStatus {
  if (h1.requests <= 0) return 'idle';
  if (m30.requests > 0 && m30.requests - m30.errors <= 0) return 'down';
  const rate = ((h1.requests - h1.errors) / h1.requests) * 100;
  // 浮点误差：95% 恰好应算正常
  if (rate + 1e-9 >= t.okRate) return 'healthy';
  if (rate + 1e-9 >= t.degradedRate) return 'degraded';
  return 'down';
}

/** 一个渠道的桶（来自 channel_stats）。 */
export interface StatBucket {
  bucketStart: number;
  requests: number;
  errors: number;
  totalUseTime: number;
  errorSamples: string;
  lastSuccessAt: number | null;
}

export interface ChannelHealth {
  status: HealthStatus;
  requests1h: number;
  errors1h: number;
  requests24h: number;
  errors24h: number;
  /** 0–1；无请求为 null */
  successRate1h: number | null;
  successRate24h: number | null;
  /** 成功请求的平均耗时（毫秒）；没有成功请求为 null */
  avgLatencyMs1h: number | null;
  avgLatencyMs24h: number | null;
  lastSuccessAt: number | null;
}

/** 桶与窗口 (now-窗口, now] 有重叠即计入。 */
const inWindow = (b: StatBucket, now: number, windowMs: number) => b.bucketStart + BUCKET_MS > now - windowMs && b.bucketStart <= now;

function sum(buckets: StatBucket[]) {
  let requests = 0;
  let errors = 0;
  let useTime = 0;
  for (const b of buckets) {
    requests += b.requests;
    errors += b.errors;
    useTime += b.totalUseTime;
  }
  return { requests, errors, useTime };
}

const rate = (requests: number, errors: number) => (requests > 0 ? (requests - errors) / requests : null);
const latency = (requests: number, errors: number, useTime: number) => (requests - errors > 0 ? Math.round((useTime / (requests - errors)) * 1000) : null);

export function computeHealth(buckets: StatBucket[], now: number, t: HealthThresholds): ChannelHealth {
  const d = buckets.filter((b) => inWindow(b, now, DAY_MS));
  const h = d.filter((b) => inWindow(b, now, HOUR_MS));
  const m = d.filter((b) => inWindow(b, now, HALF_HOUR_MS));
  const s1 = sum(h);
  const s24 = sum(d);
  const s30 = sum(m);
  let lastSuccessAt: number | null = null;
  for (const b of d) if (b.lastSuccessAt !== null && (lastSuccessAt === null || b.lastSuccessAt > lastSuccessAt)) lastSuccessAt = b.lastSuccessAt;
  return {
    status: classifyHealth(s1, s30, t),
    requests1h: s1.requests,
    errors1h: s1.errors,
    requests24h: s24.requests,
    errors24h: s24.errors,
    successRate1h: rate(s1.requests, s1.errors),
    successRate24h: rate(s24.requests, s24.errors),
    avgLatencyMs1h: latency(s1.requests, s1.errors, s1.useTime),
    avgLatencyMs24h: latency(s24.requests, s24.errors, s24.useTime),
    lastSuccessAt,
  };
}

export interface TrendPoint {
  /** 槽起点（毫秒） */
  start: number;
  requests: number;
  errors: number;
  /** 0–1；该槽无请求为 null */
  successRate: number | null;
}

/** 过去 hours 小时的趋势，按 bucketMinutes（5 的倍数）分槽，槽边界对齐，最后一槽包含 now。 */
export function computeTrend(buckets: StatBucket[], now: number, hours = 24, bucketMinutes = 30): TrendPoint[] {
  const slot = Math.max(1, Math.round(bucketMinutes / 5)) * BUCKET_MS;
  const last = Math.floor(now / slot) * slot;
  const count = Math.max(1, Math.ceil((hours * HOUR_MS) / slot));
  const points: TrendPoint[] = [];
  for (let i = count - 1; i >= 0; i--) points.push({ start: last - i * slot, requests: 0, errors: 0, successRate: null });
  const first = points[0]!.start;
  for (const b of buckets) {
    if (b.bucketStart < first || b.bucketStart >= last + slot) continue;
    const p = points[Math.floor((b.bucketStart - first) / slot)]!;
    p.requests += b.requests;
    p.errors += b.errors;
  }
  for (const p of points) p.successRate = rate(p.requests, p.errors);
  return points;
}

/** 近 24 小时错误信息 Top N（合并各桶的样本表）。 */
export function topErrors(buckets: StatBucket[], now: number): ErrorSample[] {
  return mergeSamples(...buckets.filter((b) => inWindow(b, now, DAY_MS)).map((b) => parseSamples(b.errorSamples)));
}

export interface RollupInput {
  /** 渠道在本站的启用状态（status === 1） */
  enabled: boolean;
  status: HealthStatus;
}

export interface UpstreamRollup {
  status: HealthStatus;
  /** 参与汇总的渠道数（启用且有流量） */
  counted: number;
  enabledChannels: number;
}

const SEVERITY: Record<HealthStatus, number> = { idle: 0, healthy: 1, degraded: 2, down: 3 };

/** 上游汇总：取其启用渠道里“最差”的状态；忽略已停用的渠道和空闲渠道；都没有流量则为空闲。 */
export function rollupUpstream(channels: RollupInput[]): UpstreamRollup {
  let worst: HealthStatus = 'idle';
  let counted = 0;
  let enabledChannels = 0;
  for (const c of channels) {
    if (!c.enabled) continue;
    enabledChannels++;
    if (c.status === 'idle') continue;
    counted++;
    if (SEVERITY[c.status] > SEVERITY[worst]) worst = c.status;
  }
  return { status: worst, counted, enabledChannels };
}
