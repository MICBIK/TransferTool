import { describe, expect, it } from 'vitest';
import { decideAutoAction, type ChannelState } from '../src/services/autoDisable.js';

const ch = (id: number, status: number, auto = false): ChannelState => ({ id, status, autoDisabledAt: auto ? 1 : null });

describe('余额归零自动停/恢复判定', () => {
  it('余额 ≤ 0：只停“当前为启用”的渠道（2/3 状态不动）', () => {
    const d = decideAutoAction({ enabled: true, balanceUsd: 0, channels: [ch(1, 1), ch(2, 2), ch(3, 3), ch(4, 1)] });
    expect(d).toEqual({ disableIds: [1, 4], restoreIds: [], forgetIds: [] });
    expect(decideAutoAction({ enabled: true, balanceUsd: -3.2, channels: [ch(1, 1)] }).disableIds).toEqual([1]);
  });

  it('开关关闭：不停任何渠道', () => {
    expect(decideAutoAction({ enabled: false, balanceUsd: 0, channels: [ch(1, 1)] })).toEqual({ disableIds: [], restoreIds: [], forgetIds: [] });
  });

  it('刷新失败/未知（null、NaN）：什么都不做，即使有记录', () => {
    for (const balanceUsd of [null, NaN, Infinity]) {
      expect(decideAutoAction({ enabled: true, balanceUsd, channels: [ch(1, 1), ch(2, 2, true)] })).toEqual({ disableIds: [], restoreIds: [], forgetIds: [] });
    }
  });

  it('余额 > 0：只恢复本工具停的且仍为 status 2 的；站长已改过的只清记录', () => {
    const d = decideAutoAction({
      enabled: true,
      balanceUsd: 0.01,
      channels: [ch(1, 2, true), ch(2, 1, true), ch(3, 2, false), ch(4, 3, true), ch(5, 2, true)],
    });
    expect(d.restoreIds).toEqual([1, 5]);
    expect(d.forgetIds).toEqual([2, 4]);
    expect(d.disableIds).toEqual([]); // 手动停用的 3 不动
  });

  it('余额 > 0 时恢复不受开关影响（本工具停的就应当恢复）', () => {
    expect(decideAutoAction({ enabled: false, balanceUsd: 5, channels: [ch(1, 2, true)] }).restoreIds).toEqual([1]);
  });

  it('余额 > 0 且没有记录：无动作', () => {
    expect(decideAutoAction({ enabled: true, balanceUsd: 5, channels: [ch(1, 1), ch(2, 2)] })).toEqual({ disableIds: [], restoreIds: [], forgetIds: [] });
  });
});
