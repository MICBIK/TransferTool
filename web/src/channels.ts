import { api } from './api';

export interface Channel {
  id: number;
  name: string;
  type: number;
  baseUrl: string;
  groups: string[];
  /** 1 启用、2 手动禁用、3 自动禁用 */
  status: number;
  priority: number;
  weight: number;
  responseTimeMs: number;
  tag: string;
  upstreamId: number | null;
  manualUpstream: boolean;
  /** 是本工具因余额归零停用的 */
  autoDisabled: boolean;
  syncedAt: number;
}

export interface ChannelListing {
  configured: boolean;
  syncedAt: number | null;
  lastError: string | null;
  channels: Channel[];
}

export interface SyncResult {
  ok: boolean;
  error: string | null;
  total: number;
  added: number;
  removed: number;
}

export interface StatusResult {
  requested: number;
  succeeded: number[];
  failed: { id: number; error: string }[];
}

export interface ChannelTestResult {
  passed: boolean;
  message: string;
  timeSeconds: number | null;
}

export interface ChannelCount {
  upstreamId: number | null;
  enabled: number;
  total: number;
}

export const listChannels = () => api<ChannelListing>('/api/channels');
export const channelSummary = () => api<{ configured: boolean; summary: ChannelCount[] }>('/api/channels/summary');
export const syncChannels = () => api<ChannelListing & { result: SyncResult }>('/api/channels/sync', { body: {} });
export const setChannelsStatus = (ids: number[], status: 1 | 2) => api<ChannelListing & { result: StatusResult }>('/api/channels/status', { body: { ids, status } });
export const setChannelStatus = (id: number, status: 1 | 2) => api<ChannelListing & { result: StatusResult }>(`/api/channels/${id}/status`, { body: { status } });
export const setUpstreamChannelsStatus = (upstreamId: number, status: 1 | 2) =>
  api<ChannelListing & { result: StatusResult }>(`/api/channels/upstream/${upstreamId}/status`, { body: { status } });
export const testChannel = (id: number) => api<{ result: ChannelTestResult }>(`/api/channels/${id}/test`, { body: {} }).then((r) => r.result);
export const assignUpstream = (id: number, upstreamId: number | null) => api<{ channel: Channel }>(`/api/channels/${id}/upstream`, { method: 'PUT', body: { upstreamId } }).then((r) => r.channel);

export const CHANNEL_STATUS: Record<number, { label: string; tag: 'success' | 'warning' | 'default' | 'error' }> = {
  1: { label: '启用', tag: 'success' },
  2: { label: '已停用', tag: 'default' },
  3: { label: '自动禁用', tag: 'warning' },
};
export const channelStatusMeta = (status: number) => CHANNEL_STATUS[status] ?? { label: `状态 ${status}`, tag: 'default' as const };

/** 把批量结果整理成一句话提示。 */
export function describeResult(r: StatusResult, verb: string): { ok: boolean; text: string } {
  if (r.failed.length === 0) return { ok: true, text: r.succeeded.length === 0 ? '没有需要变更的渠道' : `已${verb} ${r.succeeded.length} 个渠道` };
  const why = r.failed[0]!.error;
  return { ok: false, text: `${verb}成功 ${r.succeeded.length} 个，失败 ${r.failed.length} 个：${why}` };
}
