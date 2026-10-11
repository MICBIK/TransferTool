import { api } from './api';

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'idle';

export interface ChannelHealth {
  channelId: number;
  upstreamId: number | null;
  enabled: boolean;
  status: HealthStatus;
  requests1h: number;
  errors1h: number;
  requests24h: number;
  errors24h: number;
  /** 0–1；无请求为 null */
  successRate1h: number | null;
  successRate24h: number | null;
  avgLatencyMs1h: number | null;
  avgLatencyMs24h: number | null;
  lastSuccessAt: number | null;
}

export interface TrendPoint {
  start: number;
  requests: number;
  errors: number;
  successRate: number | null;
}

export interface ErrorSample {
  message: string;
  count: number;
}

export interface ChannelDetail extends ChannelHealth {
  bucketMinutes: number;
  trend: TrendPoint[];
  errors: ErrorSample[];
}

export interface UpstreamRollup {
  upstreamId: number;
  status: HealthStatus;
  counted: number;
  enabledChannels: number;
}

export interface IngestStatus {
  configured: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  backlog: boolean;
  cursorAt: number | null;
}

export interface HealthOverview {
  ingest: IngestStatus;
  /** 近 24 小时有消费日志却没有任何错误日志 */
  missingErrorLogs: boolean;
  thresholds: { okRate: number; degradedRate: number };
  channels: ChannelHealth[];
  upstreams: UpstreamRollup[];
}

export const getHealth = () => api<HealthOverview>('/api/health');
export const ingestNow = () => api<HealthOverview & { result: { ok: boolean; ingested: number } }>('/api/health/ingest', { body: {} });
export const getUpstreamHealth = (id: number) => api<{ rollup: UpstreamRollup; channels: ChannelDetail[] }>(`/api/health/upstreams/${id}`);

export const HEALTH_META: Record<HealthStatus, { label: string; tag: 'success' | 'warning' | 'error' | 'default'; color: string }> = {
  healthy: { label: '正常', tag: 'success', color: '#18a058' },
  degraded: { label: '降级', tag: 'warning', color: '#f0a020' },
  down: { label: '异常', tag: 'error', color: '#d03050' },
  idle: { label: '空闲', tag: 'default', color: '#909399' },
};

export const pct = (rate: number | null): string => (rate === null ? '—' : `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`);
export const latency = (ms: number | null): string => (ms === null ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
