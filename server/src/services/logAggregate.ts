import type { SiteLog } from '../adapters/index.js';

export const BUCKET_MS = 5 * 60_000;
export const MAX_SAMPLES = 5;
export const MAX_MESSAGE_CHARS = 200;
export const LOG_TYPE_CONSUME = 2;
export const LOG_TYPE_ERROR = 5;

export interface ErrorSample {
  message: string;
  count: number;
}

/** 一个 (渠道, 5 分钟桶) 的增量聚合。 */
export interface BucketAgg {
  channelId: number;
  /** 毫秒，5 分钟对齐 */
  bucketStart: number;
  requests: number;
  errors: number;
  /** 消费日志 use_time 之和（秒） */
  totalUseTime: number;
  samples: ErrorSample[];
  /** 毫秒 */
  lastSuccessAt: number | null;
}

export const bucketStartOf = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

/**
 * 归一化错误信息，使“同一类错误”聚到一起：
 * 抹掉凭证形态的串（sk-…、Bearer …）、UUID、长十六进制/请求 ID、较长的数字，折叠空白，截断到 200 字符。
 * 额外传入的 secrets（例如本站令牌）也会被替换。
 */
export function normalizeMessage(raw: string, secrets: string[] = []): string {
  let m = raw;
  for (const s of secrets) if (s.length >= 4) m = m.split(s).join('***');
  m = m
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, '<id>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  if (m === '') m = '（无错误信息）';
  return m.length > MAX_MESSAGE_CHARS ? m.slice(0, MAX_MESSAGE_CHARS) : m;
}

/** 合并若干样本表并保留次数最多的前 N 条（次数相同按信息排序，结果稳定）。 */
export function mergeSamples(...lists: ErrorSample[][]): ErrorSample[] {
  const acc = new Map<string, number>();
  for (const list of lists) for (const s of list) acc.set(s.message, (acc.get(s.message) ?? 0) + s.count);
  return [...acc]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
    .slice(0, MAX_SAMPLES);
}

export function parseSamples(json: string): ErrorSample[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      const r = x as { message?: unknown; count?: unknown } | null;
      return r && typeof r.message === 'string' && typeof r.count === 'number' && r.count > 0 ? [{ message: r.message, count: r.count }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * 把一批日志聚合成桶增量。type 2 → 成功请求；type 5 → 错误；其他类型与没有渠道 id 的日志忽略。
 * 单个桶在聚合阶段保留全部不同信息，最终入库前再裁成 Top 5（由调用方 mergeSamples 完成）。
 */
export function aggregateLogs(logs: SiteLog[], secrets: string[] = []): BucketAgg[] {
  const out = new Map<string, BucketAgg & { all: Map<string, number> }>();
  for (const l of logs) {
    if ((l.type !== LOG_TYPE_CONSUME && l.type !== LOG_TYPE_ERROR) || !Number.isInteger(l.channelId) || l.channelId <= 0) continue;
    const ms = l.createdAt * 1000;
    const bucketStart = bucketStartOf(ms);
    const key = `${l.channelId}:${bucketStart}`;
    let b = out.get(key);
    if (!b) {
      b = { channelId: l.channelId, bucketStart, requests: 0, errors: 0, totalUseTime: 0, samples: [], lastSuccessAt: null, all: new Map() };
      out.set(key, b);
    }
    b.requests++;
    if (l.type === LOG_TYPE_ERROR) {
      b.errors++;
      const msg = normalizeMessage(l.content, secrets);
      b.all.set(msg, (b.all.get(msg) ?? 0) + 1);
    } else {
      b.totalUseTime += Math.round(l.useTime);
      b.lastSuccessAt = Math.max(b.lastSuccessAt ?? 0, ms);
    }
  }
  return [...out.values()].map(({ all, ...b }) => ({ ...b, samples: mergeSamples([...all].map(([message, count]) => ({ message, count }))) }));
}
