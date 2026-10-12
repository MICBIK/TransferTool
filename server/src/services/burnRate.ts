export interface BalancePoint {
  ts: number;
  balanceUsd: number;
}

/**
 * estimated：已估算；collecting：样本还不够（刚添加或只刷新过一两次）；
 * no_usage：已观察足够时长但余额没有下降。
 */
export type BurnBasis = 'estimated' | 'collecting' | 'no_usage';

export interface BurnEstimate {
  basis: BurnBasis;
  /** 消耗速度，USD/天；样本不足或没有下降时为 null */
  usdPerDay: number | null;
  /** 预计耗尽的时间戳（毫秒）；无法估算为 null */
  exhaustAt: number | null;
}

export const BURN_WINDOW_MS = 24 * 3600 * 1000;
/** 样本跨度太短时估算不可靠 */
const MIN_SPAN_MS = 5 * 60 * 1000;

/**
 * 按最近窗口内的快照估算消耗速度。
 * 只累计相邻快照之间的“下降量”和对应时长；上升（充值）的区间连同其时长一并剔除，持平的区间计入时长，
 * 因此充值造成的上升段不会拉低速度，也不会把速度算成负数。
 * points 须为成功快照，按时间升序或乱序均可。
 */
export function estimateBurn(points: BalancePoint[], now: number, windowMs = BURN_WINDOW_MS): BurnEstimate {
  const inWindow = points.filter((p) => p.ts >= now - windowMs && p.ts <= now).sort((a, b) => a.ts - b.ts);
  let consumed = 0;
  let span = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1]!;
    const b = inWindow[i]!;
    const delta = b.balanceUsd - a.balanceUsd;
    if (delta > 0) continue; // 充值
    consumed += -delta;
    span += b.ts - a.ts;
  }
  if (span < MIN_SPAN_MS) return { basis: 'collecting', usdPerDay: null, exhaustAt: null };
  if (consumed <= 0) return { basis: 'no_usage', usdPerDay: null, exhaustAt: null };
  const usdPerDay = (consumed / span) * 24 * 3600 * 1000;
  const last = inWindow.at(-1)!;
  const exhaustAt = last.balanceUsd > 0 ? now + (last.balanceUsd / usdPerDay) * 24 * 3600 * 1000 : now;
  return { basis: 'estimated', usdPerDay, exhaustAt };
}
