import { api } from './api';

export type UpstreamType = 'newapi' | 'sub2api';
export type SecretField = 'credential' | 'userId' | 'account' | 'password';
export type UpstreamStatus = 'ok' | 'low' | 'critical' | 'unknown' | 'unsupported' | 'pending' | 'disabled' | 'setup';

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
  /** estimated：已估算；collecting：数据还不够；no_usage：观察期内没有消耗；null：没有可用余额 */
  burnBasis: 'estimated' | 'collecting' | 'no_usage' | null;
  /** 根据本站渠道自动创建、还没填凭证 */
  needsSetup: boolean;
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

const STATUS_ORDER: Record<UpstreamStatus, number> = { setup: 0, critical: 1, low: 2, unknown: 3, unsupported: 4, ok: 5, pending: 6, disabled: 7 };
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
  setup: { label: '待配置', tag: 'info', color: '#2080f0' },
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

/** 消耗速度文案：估算不出来时说明原因，数据不够时给出大约还要等多久。 */
export function burnText(u: Upstream, now = Date.now()): string {
  if (u.burnBasis === 'estimated' && u.burnUsdPerDay !== null) return `${usd(u.burnUsdPerDay)}/天`;
  if (u.burnBasis === 'no_usage') return '暂无消耗（余额未下降）';
  if (u.burnBasis === 'collecting') {
    // 至少需要两次成功刷新、相隔 5 分钟以上，且期间余额有下降
    const next = u.lastSuccessAt === null ? null : u.lastSuccessAt + Math.max(u.intervalMinutes, 5) * 60_000;
    const mins = next === null ? null : Math.ceil((next - now) / 60_000);
    return mins !== null && mins > 0 ? `收集数据中，约 ${mins} 分钟后可估算` : '收集数据中，下次刷新后可估算';
  }
  return '暂无法估算';
}

/** 预计可用文案，与 burnText 配套 */
export function etaText(u: Upstream, now = Date.now()): string {
  if (u.balanceUsd === null) return '—';
  if (u.burnBasis === 'no_usage') return '—（近期无消耗）';
  if (u.burnBasis !== 'estimated') return '待估算';
  return formatEta(u.exhaustAt, now);
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return '从未';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
