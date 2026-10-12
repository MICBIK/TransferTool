export interface ChannelState {
  id: number;
  /** 1 启用、2 手动禁用、3 自动禁用 */
  status: number;
  /** 非空 = 本工具因余额归零停掉的 */
  autoDisabledAt: number | null;
}

export interface AutoDecision {
  /** 需要停用的渠道（当前为启用状态） */
  disableIds: number[];
  /** 需要恢复的渠道（本工具停掉的、且仍是 status 2） */
  restoreIds: number[];
  /** 需要清除“本工具停用”记录的渠道（已被站长改动，或已恢复） */
  forgetIds: number[];
}

export const NO_ACTION: AutoDecision = { disableIds: [], restoreIds: [], forgetIds: [] };

export interface AutoDecisionInput {
  /** “余额归零自动停渠道”开关 */
  enabled: boolean;
  /** 本轮刷新得到的余额（USD）；刷新失败/未知/订阅制为 null */
  balanceUsd: number | null;
  channels: ChannelState[];
}

/**
 * 余额归零自动停/恢复的纯判定。
 *  - 刷新失败或余额未知（null / 非有限数）：什么都不做。
 *  - 余额 ≤ 0：仅在开关打开时，停用“当前为启用状态”的渠道（状态 2/3 不动）。
 *  - 余额 > 0：只恢复本工具记录过、且当前仍是 status 2 的渠道；
 *    记录里其余渠道（站长已手动改过状态）不动，只清掉记录。
 *    恢复不受开关影响：已经被本工具停掉的渠道，余额回来就应当恢复。
 * Key 限额（sub2api quota_limited）用完同样视为余额 ≤ 0，由调用方传入余额即可。
 */
export function decideAutoAction(input: AutoDecisionInput): AutoDecision {
  const { balanceUsd, channels } = input;
  if (balanceUsd === null || !Number.isFinite(balanceUsd)) return NO_ACTION;

  if (balanceUsd <= 0) {
    if (!input.enabled) return NO_ACTION;
    return { disableIds: channels.filter((c) => c.status === 1).map((c) => c.id), restoreIds: [], forgetIds: [] };
  }

  const recorded = channels.filter((c) => c.autoDisabledAt !== null);
  const restoreIds = recorded.filter((c) => c.status === 2).map((c) => c.id);
  const restoring = new Set(restoreIds);
  return { disableIds: [], restoreIds, forgetIds: recorded.filter((c) => !restoring.has(c.id)).map((c) => c.id) };
}

export const hasAction = (d: AutoDecision): boolean => d.disableIds.length > 0 || d.restoreIds.length > 0 || d.forgetIds.length > 0;
