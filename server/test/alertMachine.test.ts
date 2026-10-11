import { describe, expect, it } from 'vitest';
import { decideAlert, type AlertRecord } from '../src/services/alertMachine.js';
import { estimateBurn } from '../src/services/burnRate.js';

const H = 3600_000;
const NOW = 1_700_000_000_000;
const normal: AlertRecord = { state: 'normal', lastSentAt: null };
const run = (prev: AlertRecord, balanceUsd: number | null, over: { now?: number; emergency?: number | null } = {}) =>
  decideAlert({ prev, balanceUsd, threshold: 10, emergencyThreshold: over.emergency === undefined ? 2 : over.emergency, now: over.now ?? NOW, repeatIntervalMs: 6 * H });

describe('提醒状态机', () => {
  it('从 ≥ 阈值跌破阈值：发送并记录时间', () => {
    expect(run(normal, 9.99)).toEqual({ send: true, reason: 'crossed_low', next: { state: 'low', lastSentAt: NOW } });
  });
  it('恰好等于阈值不算跌破（< 才算）', () => {
    expect(run(normal, 10)).toMatchObject({ send: false, next: { state: 'normal' } });
  });
  it('持续低于阈值：间隔内不发，满间隔再发', () => {
    const prev: AlertRecord = { state: 'low', lastSentAt: NOW };
    expect(run(prev, 8, { now: NOW + 6 * H - 1 }).send).toBe(false);
    expect(run(prev, 8, { now: NOW + 6 * H })).toMatchObject({ send: true, reason: 'repeat', next: { state: 'low', lastSentAt: NOW + 6 * H } });
  });
  it('间隔可配置', () => {
    const d = decideAlert({ prev: { state: 'low', lastSentAt: NOW }, balanceUsd: 5, threshold: 10, emergencyThreshold: null, now: NOW + 2 * H, repeatIntervalMs: 2 * H });
    expect(d.send).toBe(true);
  });
  it('直接跌破紧急阈值：发送', () => {
    expect(run(normal, 1)).toMatchObject({ send: true, reason: 'crossed_critical', next: { state: 'critical' } });
  });
  it('low → critical：不受间隔限制，立即发送', () => {
    const prev: AlertRecord = { state: 'low', lastSentAt: NOW - 1000 };
    expect(run(prev, 1.5)).toMatchObject({ send: true, reason: 'crossed_critical', next: { state: 'critical', lastSentAt: NOW } });
  });
  it('critical 持续：同一状态只发一次，即使超过间隔', () => {
    const prev: AlertRecord = { state: 'critical', lastSentAt: NOW - 100 * H };
    expect(run(prev, 1).send).toBe(false);
  });
  it('critical 回升到紧急阈值之上但仍低于阈值：不发信，沿用 lastSentAt，再次跌破会重新发', () => {
    const prev: AlertRecord = { state: 'critical', lastSentAt: NOW - H };
    const up = run(prev, 5);
    expect(up).toMatchObject({ send: false, next: { state: 'low', lastSentAt: NOW - H } });
    expect(run(up.next, 1).send).toBe(true);
  });
  it('恢复到阈值以上：回到 normal 并清空，下次跌破重新提醒', () => {
    const low: AlertRecord = { state: 'low', lastSentAt: NOW - H };
    const rec = run(low, 50);
    expect(rec).toMatchObject({ send: false, next: { state: 'normal', lastSentAt: null } });
    expect(run(rec.next, 3, { now: NOW + 1 }).send).toBe(true);
  });
  it('查询失败（null/NaN）不算跌破，也不算恢复：状态原样保留', () => {
    expect(run(normal, null)).toEqual({ send: false, reason: null, next: normal });
    const low: AlertRecord = { state: 'low', lastSentAt: NOW - 100 * H };
    expect(run(low, null)).toEqual({ send: false, reason: null, next: low });
    expect(run(low, Number.NaN).send).toBe(false);
  });
  it('没有紧急阈值时只有 low', () => {
    expect(run(normal, 0, { emergency: null })).toMatchObject({ next: { state: 'low' } });
  });
  it('该提醒却没有发送记录（上次发信失败）：重试', () => {
    expect(run({ state: 'low', lastSentAt: null }, 5)).toMatchObject({ send: true, reason: 'retry' });
    expect(run({ state: 'critical', lastSentAt: null }, 1)).toMatchObject({ send: true, reason: 'retry' });
  });
});

describe('消耗速度估算', () => {
  it('匀速下降：按下降量/时长估算，并给出耗尽时间', () => {
    // 12 小时消耗 6 美元 => 12 USD/天；当前 6 美元 => 12 小时后耗尽
    const now = NOW - 12 * H;
    const points = [
      { ts: now - 12 * H, balanceUsd: 12 },
      { ts: now - 6 * H, balanceUsd: 9 },
      { ts: now, balanceUsd: 6 },
    ];
    const e = estimateBurn(points, now);
    expect(e.usdPerDay).toBeCloseTo(12, 6);
    expect(e.exhaustAt).toBeCloseTo(now + 12 * H, -2);
  });
  it('剔除充值造成的上升段', () => {
    const now = NOW;
    const points = [
      { ts: now - 4 * H, balanceUsd: 10 },
      { ts: now - 3 * H, balanceUsd: 9 }, // -1 / 1h
      { ts: now - 2 * H, balanceUsd: 109 }, // 充值 +100，剔除
      { ts: now - 1 * H, balanceUsd: 108 }, // -1 / 1h
      { ts: now, balanceUsd: 107 }, // -1 / 1h
    ];
    const e = estimateBurn(points, now);
    expect(e.usdPerDay).toBeCloseTo(24, 6); // 3 美元 / 3 小时
    expect(e.exhaustAt).toBeCloseTo(now + (107 / 24) * 24 * H, -2);
  });
  it('只有上升/持平、样本太少或跨度过短：无法估算', () => {
    expect(estimateBurn([{ ts: NOW - H, balanceUsd: 1 }, { ts: NOW, balanceUsd: 5 }], NOW)).toEqual({ usdPerDay: null, exhaustAt: null });
    expect(estimateBurn([{ ts: NOW - H, balanceUsd: 5 }, { ts: NOW, balanceUsd: 5 }], NOW).usdPerDay).toBeNull();
    expect(estimateBurn([{ ts: NOW, balanceUsd: 5 }], NOW).usdPerDay).toBeNull();
    expect(estimateBurn([{ ts: NOW - 60_000, balanceUsd: 6 }, { ts: NOW, balanceUsd: 5 }], NOW).usdPerDay).toBeNull();
  });
  it('只看最近 24 小时', () => {
    const e = estimateBurn(
      [
        { ts: NOW - 30 * H, balanceUsd: 1000 },
        { ts: NOW - 29 * H, balanceUsd: 500 },
        { ts: NOW - 2 * H, balanceUsd: 10 },
        { ts: NOW - 1 * H, balanceUsd: 9 },
      ],
      NOW,
    );
    expect(e.usdPerDay).toBeCloseTo(24, 6);
  });
});
