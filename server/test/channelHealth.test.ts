import { describe, expect, it } from 'vitest';
import { classifyHealth, computeHealth, computeTrend, rollupUpstream, topErrors, type StatBucket } from '../src/services/channelHealth.js';
import { BUCKET_MS } from '../src/services/logAggregate.js';

const T = { okRate: 95, degradedRate: 80 };
const c = (requests: number, errors: number) => ({ requests, errors });

describe('状态判定', () => {
  it('成功率阈值边界：95 正常、80 降级、低于 80 异常', () => {
    expect(classifyHealth(c(100, 5), c(10, 0), T)).toBe('healthy'); // 恰好 95%
    expect(classifyHealth(c(100, 6), c(10, 0), T)).toBe('degraded');
    expect(classifyHealth(c(100, 20), c(10, 0), T)).toBe('degraded'); // 恰好 80%
    expect(classifyHealth(c(100, 21), c(10, 0), T)).toBe('down');
    expect(classifyHealth(c(20, 1), c(5, 0), T)).toBe('healthy');
  });

  it('近 1 小时没有请求为空闲', () => {
    expect(classifyHealth(c(0, 0), c(0, 0), T)).toBe('idle');
  });

  it('30 分钟内有请求但一次成功都没有 → 异常，即使 1 小时成功率很高', () => {
    expect(classifyHealth(c(1000, 3), c(3, 3), T)).toBe('down');
    expect(classifyHealth(c(1000, 3), c(0, 0), T)).toBe('healthy'); // 30 分钟内没有请求：按 1 小时判
  });

  it('阈值可调', () => {
    expect(classifyHealth(c(100, 10), c(10, 0), { okRate: 90, degradedRate: 50 })).toBe('healthy');
    expect(classifyHealth(c(100, 40), c(10, 0), { okRate: 90, degradedRate: 50 })).toBe('degraded');
    expect(classifyHealth(c(100, 60), c(10, 0), { okRate: 90, degradedRate: 50 })).toBe('down');
  });
});

const NOW = 1_700_000_000_000;
const align = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
const bucket = (agoMin: number, requests: number, errors: number, over: Partial<StatBucket> = {}): StatBucket => ({
  bucketStart: align(NOW - agoMin * 60_000),
  requests,
  errors,
  totalUseTime: (requests - errors) * 2,
  errorSamples: '[]',
  lastSuccessAt: requests > errors ? align(NOW - agoMin * 60_000) + 1000 : null,
  ...over,
});

describe('健康指标', () => {
  it('1h/24h 成功率、平均耗时（只算成功请求）、最近成功时间', () => {
    const buckets = [bucket(2, 50, 0), bucket(40, 50, 10), bucket(300, 100, 50)];
    const h = computeHealth(buckets, NOW, T);
    expect(h).toMatchObject({ requests1h: 100, errors1h: 10, requests24h: 200, errors24h: 60 });
    expect(h.successRate1h).toBeCloseTo(0.9);
    expect(h.successRate24h).toBeCloseTo(0.7);
    expect(h.avgLatencyMs1h).toBe(2000);
    expect(h.status).toBe('degraded');
    expect(h.lastSuccessAt).toBe(buckets[0]!.lastSuccessAt);
  });

  it('超过 24 小时的桶不计入；没有请求时比率与耗时为 null', () => {
    const h = computeHealth([bucket(25 * 60, 10, 0)], NOW, T);
    expect(h).toMatchObject({ requests24h: 0, successRate1h: null, successRate24h: null, avgLatencyMs24h: null, lastSuccessAt: null, status: 'idle' });
  });

  it('近 30 分钟全是错误 → 异常', () => {
    const h = computeHealth([bucket(50, 500, 0), bucket(3, 4, 4)], NOW, T);
    expect(h.status).toBe('down');
  });

  it('趋势按槽对齐、补零，最后一槽含当前时间', () => {
    const trend = computeTrend([bucket(2, 10, 5), bucket(70, 4, 0)], NOW, 24, 60);
    expect(trend).toHaveLength(24);
    expect(trend.at(-1)!.start).toBe(Math.floor(NOW / 3600_000) * 3600_000);
    expect(trend.reduce((s, p) => s + p.requests, 0)).toBe(14);
    expect(trend.filter((p) => p.successRate === null).length).toBeGreaterThanOrEqual(21);
  });

  it('错误 Top 5 合并各桶并按次数排序', () => {
    const samples = (list: [string, number][]) => JSON.stringify(list.map(([message, count]) => ({ message, count })));
    const top = topErrors([bucket(5, 5, 5, { errorSamples: samples([['a', 2], ['b', 3]]) }), bucket(10, 5, 5, { errorSamples: samples([['a', 4], ['c', 1]]) }), bucket(30 * 60, 9, 9, { errorSamples: samples([['old', 99]]) })], NOW);
    expect(top).toEqual([{ message: 'a', count: 6 }, { message: 'b', count: 3 }, { message: 'c', count: 1 }]);
  });
});

describe('上游汇总', () => {
  it('取启用且有流量渠道里最差的状态，忽略空闲与已停用', () => {
    expect(rollupUpstream([{ enabled: true, status: 'healthy' }, { enabled: true, status: 'degraded' }, { enabled: true, status: 'idle' }])).toEqual({ status: 'degraded', counted: 2, enabledChannels: 3 });
    expect(rollupUpstream([{ enabled: true, status: 'healthy' }, { enabled: false, status: 'down' }])).toMatchObject({ status: 'healthy', counted: 1 });
    expect(rollupUpstream([{ enabled: true, status: 'down' }, { enabled: true, status: 'degraded' }]).status).toBe('down');
  });

  it('没有启用渠道，或都没有流量 → 空闲', () => {
    expect(rollupUpstream([])).toEqual({ status: 'idle', counted: 0, enabledChannels: 0 });
    expect(rollupUpstream([{ enabled: true, status: 'idle' }, { enabled: false, status: 'down' }]).status).toBe('idle');
  });
});
