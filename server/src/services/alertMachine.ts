export type AlertState = 'normal' | 'low' | 'critical';

export interface AlertRecord {
  state: AlertState;
  /** 上次成功发出提醒的时间（毫秒）；从未发送为 null */
  lastSentAt: number | null;
}

export interface AlertInput {
  prev: AlertRecord;
  /** 本次查询得到的余额；查询失败/未知为 null */
  balanceUsd: number | null;
  threshold: number;
  emergencyThreshold: number | null;
  now: number;
  /** 持续低于阈值时的最短重复提醒间隔（毫秒） */
  repeatIntervalMs: number;
}

export type AlertReason = 'crossed_low' | 'crossed_critical' | 'repeat' | 'retry';

export interface AlertDecision {
  /** 若发送成功应当持久化的新状态（发送时 lastSentAt 已更新为 now） */
  next: AlertRecord;
  send: boolean;
  reason: AlertReason | null;
}

export function classify(balanceUsd: number, threshold: number, emergencyThreshold: number | null): AlertState {
  if (emergencyThreshold !== null && balanceUsd < emergencyThreshold) return 'critical';
  if (balanceUsd < threshold) return 'low';
  return 'normal';
}

/**
 * 提醒状态机（纯函数）：
 *  - 查询失败（balance 为 null）：状态原样保留，绝不算跌破，也不算恢复
 *  - normal → low / critical：发送
 *  - low → critical：立即发送（不受间隔限制）
 *  - low 持续：距上次发送满 repeatIntervalMs 才再发
 *  - critical 持续：同一状态只发一次；critical → low 不发送（但沿用 lastSentAt 继续计间隔）
 *  - 回到阈值及以上：恢复 normal 并清空 lastSentAt，下次跌破重新提醒
 *  - 状态应当已提醒却没有 lastSentAt（上次发信失败）：重试
 * 调用方在邮件发送失败时不应持久化 next，这样下一轮会再次判定为需要发送。
 */
export function decideAlert(input: AlertInput): AlertDecision {
  const { prev, balanceUsd, now } = input;
  const keep: AlertDecision = { next: prev, send: false, reason: null };
  if (balanceUsd === null || !Number.isFinite(balanceUsd)) return keep;

  const state = classify(balanceUsd, input.threshold, input.emergencyThreshold);
  if (state === 'normal') {
    return { next: { state: 'normal', lastSentAt: null }, send: false, reason: null };
  }

  const sent = (reason: AlertReason): AlertDecision => ({ next: { state, lastSentAt: now }, send: true, reason });

  if (prev.state === 'normal') return sent(state === 'critical' ? 'crossed_critical' : 'crossed_low');
  if (state === 'critical') {
    if (prev.state === 'low') return sent('crossed_critical');
    return prev.lastSentAt === null ? sent('retry') : keep;
  }
  // state === 'low'
  if (prev.state === 'critical') {
    // 回升到紧急阈值之上但仍低于阈值：只换状态，不发信
    return { next: { state: 'low', lastSentAt: prev.lastSentAt }, send: false, reason: null };
  }
  if (prev.lastSentAt === null) return sent('retry');
  if (now - prev.lastSentAt >= input.repeatIntervalMs) return sent('repeat');
  return keep;
}
