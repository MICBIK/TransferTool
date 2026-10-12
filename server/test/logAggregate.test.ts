import { describe, expect, it } from 'vitest';
import type { SiteLog } from '../src/adapters/index.js';
import { aggregateLogs, bucketStartOf, BUCKET_MS, mergeSamples, normalizeMessage } from '../src/services/logAggregate.js';

const log = (over: Partial<SiteLog>): SiteLog => ({ id: 1, createdAt: 1_700_000_000, type: 2, channelId: 7, useTime: 2, content: '', ...over });

describe('错误信息归一化', () => {
  it('抹掉请求 ID、UUID、长数字和凭证形态的串，折叠空白', () => {
    const a = normalizeMessage('upstream error  (request id: 2024101012345678ABCDEFGH)  status 429');
    const b = normalizeMessage('upstream error (request id: 2099999999999999ZZZZZZZZ) status 429');
    expect(a).toBe(b);
    expect(a).toContain('429');
    expect(normalizeMessage('bad key sk-abcdef1234567890XYZ in request 123e4567-e89b-12d3-a456-426614174000')).toBe('bad key sk-*** in request <id>');
    expect(normalizeMessage('Authorization: Bearer abcdefgh12345678')).toBe('Authorization: Bearer ***');
    expect(normalizeMessage('failed for tok-SECRET-1234', ['tok-SECRET-1234'])).toBe('failed for ***');
    expect(normalizeMessage('   ')).toBe('（无错误信息）');
  });

  it('截断到 200 字符', () => {
    expect(normalizeMessage('x'.repeat(500))).toHaveLength(200);
    expect(normalizeMessage('错'.repeat(500))).toHaveLength(200);
  });
});

describe('日志聚合', () => {
  it('按渠道与 5 分钟桶计数；错误计入 requests 与 errors；耗时只累计成功请求', () => {
    const t0 = 1_700_000_100; // 桶内
    const aggs = aggregateLogs([
      log({ id: 1, createdAt: t0, type: 2, useTime: 3 }),
      log({ id: 2, createdAt: t0 + 10, type: 2, useTime: 5 }),
      log({ id: 3, createdAt: t0 + 20, type: 5, useTime: 60, content: 'boom 1' }),
      log({ id: 4, createdAt: t0 + 20 + 300, type: 2, useTime: 1 }),
      log({ id: 5, createdAt: t0, type: 2, channelId: 8 }),
    ]);
    const first = aggs.find((a) => a.channelId === 7 && a.bucketStart === bucketStartOf(t0 * 1000))!;
    expect(first).toMatchObject({ requests: 3, errors: 1, totalUseTime: 8, samples: [{ message: 'boom 1', count: 1 }], lastSuccessAt: (t0 + 10) * 1000 });
    expect(first.bucketStart % BUCKET_MS).toBe(0);
    expect(aggs).toHaveLength(3);
    expect(aggs.find((a) => a.channelId === 7 && a.bucketStart === first.bucketStart + BUCKET_MS)).toMatchObject({ requests: 1, errors: 0 });
  });

  it('忽略其他日志类型和没有渠道 id 的日志；只保留 Top 5 错误', () => {
    const logs = [log({ type: 1 }), log({ channelId: 0 }), log({ type: 3 })];
    for (let i = 0; i < 8; i++) for (let k = 0; k <= i; k++) logs.push(log({ id: 100 + i * 10 + k, type: 5, content: `err-kind-${i}` }));
    const [agg] = aggregateLogs(logs);
    expect(agg!.requests).toBe(36);
    expect(agg!.samples.map((s) => s.message)).toEqual(['err-kind-7', 'err-kind-6', 'err-kind-5', 'err-kind-4', 'err-kind-3']);
    expect(agg!.samples[0]!.count).toBe(8);
  });

  it('mergeSamples 相加同名信息并稳定排序', () => {
    expect(mergeSamples([{ message: 'b', count: 2 }, { message: 'a', count: 2 }], [{ message: 'b', count: 1 }])).toEqual([
      { message: 'b', count: 3 },
      { message: 'a', count: 2 },
    ]);
  });
});
