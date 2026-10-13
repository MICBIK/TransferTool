import { api } from './api';

export type DashboardDays = 1 | 7 | 30;
export type HourPoint = [number, number];

export interface DashboardSeries {
  now: number;
  since: number;
  balance: { upstreamId: number; points: HourPoint[] }[];
  spend: { upstreamId: number; points: HourPoint[] }[];
  traffic: [number, number, number][];
  trafficByUpstream: { upstreamId: number | null; requests: number; errors: number }[];
}

export const getDashboard = (days: DashboardDays) => api<DashboardSeries>(`/api/dashboard?days=${days}`);

export const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 分类色板（固定顺序，按上游 id 依次分配，不随排序或筛选变化）。
 * 超过 8 个上游时，其余合并为“其他”，用中性灰。
 */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER_COLOR = '#8a8986';
/** 状态色只用于成功 / 失败，不与上游配色混用 */
export const STATUS_GOOD = '#0ca30c';
export const STATUS_CRITICAL = '#d03b3b';

export interface Entity {
  key: string;
  label: string;
  color: string;
  ids: number[];
}

/**
 * 给上游分配颜色：按 id 升序取色板第 n 个；超过 8 个时保留 weight 最大的 7 个，其余并为“其他”。
 * 颜色只由 id 顺序决定，所以同一个上游在每张图里颜色一致。
 */
export function assignEntities(upstreams: { id: number; name: string }[], weight: (id: number) => number): Entity[] {
  const byId = [...upstreams].sort((a, b) => a.id - b.id);
  const color = new Map(byId.map((u, i) => [u.id, SERIES_COLORS[i % SERIES_COLORS.length]!]));
  if (byId.length <= SERIES_COLORS.length) return byId.map((u) => ({ key: String(u.id), label: u.name, color: color.get(u.id)!, ids: [u.id] }));
  const keep = new Set(
    [...byId]
      .sort((a, b) => weight(b.id) - weight(a.id))
      .slice(0, SERIES_COLORS.length - 1)
      .map((u) => u.id),
  );
  // 被保留的上游重新按 id 顺序取前 7 个色，避免“其他”占用某个上游的颜色
  const kept = byId.filter((u) => keep.has(u.id));
  const out: Entity[] = kept.map((u, i) => ({ key: String(u.id), label: u.name, color: SERIES_COLORS[i]!, ids: [u.id] }));
  out.push({ key: 'other', label: `其他 ${byId.length - kept.length} 个`, color: OTHER_COLOR, ids: byId.filter((u) => !keep.has(u.id)).map((u) => u.id) });
  return out;
}

/** 区间对应的柱状图桶宽：1 天按小时，7 天按 6 小时，30 天按天（按本地时间对齐） */
export function bucketMs(days: DashboardDays): number {
  return days === 1 ? HOUR_MS : days === 7 ? 6 * HOUR_MS : DAY_MS;
}

/** 本地时间对齐的桶起点 */
export function bucketStart(ts: number, size: number): number {
  const d = new Date(ts);
  if (size >= DAY_MS) return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const hours = size / HOUR_MS;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(d.getHours() / hours) * hours).getTime();
}

/** since..now 之间的全部桶起点 */
export function bucketRange(since: number, now: number, size: number): number[] {
  const out: number[] = [];
  for (let t = bucketStart(since, size); t <= now; ) {
    out.push(t);
    const d = new Date(t);
    t = size >= DAY_MS ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() : t + size;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function bucketLabel(ts: number, size: number, days: DashboardDays): string {
  const d = new Date(ts);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (size >= DAY_MS) return date;
  const time = `${pad(d.getHours())}:00`;
  return days === 1 ? time : `${date} ${time}`;
}

/** 金额简写：$1.2k */
export function compactUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function pct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(rate >= 0.999 || rate === 0 ? 0 : 1)}%`;
}
