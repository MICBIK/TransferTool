import { api } from './api';

export type UpstreamType = 'newapi' | 'sub2api';
export type SecretField = 'credential' | 'userId' | 'account' | 'password';
export type UpstreamStatus = 'ok' | 'low' | 'critical' | 'unknown' | 'unsupported' | 'pending' | 'disabled';

export interface Upstream {
  id: number;
  name: string;
  type: UpstreamType;
  siteUrl: string;
  matchDomains: string[];
  topupUrl: string | null;
  effectiveTopupUrl: string | null;
  threshold: number;
  emergencyThreshold: number | null;
  intervalMinutes: number;
  rateFactor: number;
  enabled: boolean;
  note: string;
  secrets: Record<SecretField, { set: boolean; masked: string }>;
  status: UpstreamStatus;
  balanceUsd: number | null;
  balanceKind: 'wallet' | 'key_limit' | null;
  mode: string | null;
  alertState: 'normal' | 'low' | 'critical';
  alertLastSentAt: number | null;
  alertLastResult: string | null;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  burnUsdPerDay: number | null;
  exhaustAt: number | null;
}

export interface TestResult {
  ok: boolean;
  balanceUsd: number | null;
  mode: string;
  kind: 'wallet' | 'key_limit' | null;
  unsupported: boolean;
  error: string | null;
}

export interface HistoryPoint {
  ts: number;
  balanceUsd: number;
}

export const listUpstreams = () => api<{ upstreams: Upstream[] }>('/api/upstreams').then((r) => r.upstreams);
export const getUpstream = (id: number) => api<{ upstream: Upstream }>(`/api/upstreams/${id}`).then((r) => r.upstream);
export const refreshAll = () => api<{ upstreams: Upstream[] }>('/api/upstreams/refresh', { body: {} }).then((r) => r.upstreams);
export const refreshOne = (id: number) => api<{ upstream: Upstream }>(`/api/upstreams/${id}/refresh`, { body: {} }).then((r) => r.upstream);
export const getHistory = (id: number, days: number) =>
  api<{ points: HistoryPoint[]; threshold: number; emergencyThreshold: number | null }>(`/api/upstreams/${id}/history?days=${days}`);
export const copySecret = (id: number, field: SecretField) =>
  api<{ value: string }>(`/api/upstreams/${id}/secrets/${field}/copy`, { body: {} }).then((r) => r.value);

const STATUS_ORDER: Record<UpstreamStatus, number> = { critical: 0, low: 1, unknown: 2, unsupported: 3, ok: 4, pending: 5, disabled: 6 };
/** 低于阈值/异常排前 */
export function sortUpstreams(list: Upstream[]): Upstream[] {
  return [...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'zh-CN'));
}

export const STATUS_META: Record<UpstreamStatus, { label: string; tag: 'success' | 'warning' | 'error' | 'default' | 'info'; color: string }> = {
  ok: { label: '正常', tag: 'success', color: '#18a058' },
  low: { label: '余额不足', tag: 'warning', color: '#f0a020' },
  critical: { label: '紧急', tag: 'error', color: '#d03050' },
  unknown: { label: '余额未知', tag: 'error', color: '#d03050' },
  unsupported: { label: '暂不支持订阅制', tag: 'info', color: '#909399' },
  pending: { label: '等待首次刷新', tag: 'default', color: '#909399' },
  disabled: { label: '已停用', tag: 'default', color: '#909399' },
};

export const TYPE_LABEL: Record<UpstreamType, string> = { newapi: 'new-api', sub2api: 'sub2api' };

export const usd = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);

/** 与提醒邮件中的“预计耗尽”文案保持一致。 */
export function formatEta(exhaustAt: number | null, now = Date.now()): string {
  if (exhaustAt === null) return '无法估算';
  const hours = Math.max(0, (exhaustAt - now) / 3600_000);
  const span = hours >= 48 ? `约 ${(hours / 24).toFixed(1)} 天` : hours >= 1 ? `约 ${hours.toFixed(1)} 小时` : '不足 1 小时';
  return `${span}后（${new Date(exhaustAt).toLocaleString('zh-CN', { hour12: false })}）`;
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return '从未';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
