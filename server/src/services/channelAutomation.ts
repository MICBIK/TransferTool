import type { AuditService } from './audit.js';
import { decideAutoAction, hasAction, type AutoDecision } from './autoDisable.js';
import type { ChannelRow, ChannelService } from './channels.js';
import type { SettingsStore } from './settings.js';
import type { UpstreamRow } from './upstreams.js';

export interface AutoCandidate {
  upstream: UpstreamRow;
  /** 本轮刷新成功得到的余额（USD）；失败/未知/订阅制为 null */
  balanceUsd: number | null;
  keyLimit: boolean;
}

const idList = (ids: number[]) => ids.slice(0, 50).join(',') + (ids.length > 50 ? `…（共 ${ids.length} 个）` : '');
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * 余额归零自动停渠道 / 恢复。每轮余额刷新结束后调用。
 * 判定本身是纯函数（autoDisable.ts）；这里负责：先同步一次本站以拿到最新状态、
 * 批量启停、记录“本工具停了哪些”、写 audit_log。
 */
export class ChannelAutomation {
  constructor(
    private readonly deps: { channels: ChannelService; settings: SettingsStore; audit: AuditService; log?: (msg: string) => void },
  ) {}

  private decide(c: AutoCandidate, rows: ChannelRow[]): AutoDecision {
    return decideAutoAction({
      enabled: this.deps.settings.get('auto_disable_at_zero') === 'true',
      balanceUsd: c.balanceUsd,
      channels: rows.map((r) => ({ id: r.channelId, status: r.status, autoDisabledAt: r.autoDisabledAt })),
    });
  }

  async process(candidates: AutoCandidate[]): Promise<void> {
    const { channels } = this.deps;
    if (!channels.configured) return;
    const known = candidates.filter((c) => c.balanceUsd !== null);
    // 先用缓存粗判：无事可做就不必打扰本站
    if (!known.some((c) => hasAction(this.decide(c, channels.rowsForUpstream(c.upstream.id))))) return;

    const sync = await channels.sync();
    if (!sync.ok) {
      this.deps.audit.record('channel.auto_skipped', { detail: `无法同步本站渠道，本轮不自动启停：${sync.error ?? ''}`.slice(0, 300) });
      return;
    }
    for (const c of known) {
      const decision = this.decide(c, channels.rowsForUpstream(c.upstream.id));
      if (!hasAction(decision)) continue;
      try {
        await this.apply(c, decision);
      } catch (err) {
        (this.deps.log ?? console.error)(`[channels] 自动启停出错：${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }

  private async apply(c: AutoCandidate, d: AutoDecision): Promise<void> {
    const { channels, audit } = this.deps;
    const target = `upstream:${c.upstream.id}`;
    const balance = c.balanceUsd ?? 0;
    const label = `${c.upstream.name}${c.keyLimit ? '（Key 限额）' : ''}`;

    if (d.disableIds.length > 0) {
      const r = await channels.setStatus(d.disableIds, 2, { source: 'auto' });
      let recorded = r.succeeded;
      if (r.failed.length > 0) {
        // 批量请求出错时，本站可能已经停掉了其中一部分：重新同步确认并补记，保证“恢复时一个不漏”
        recorded = [...recorded, ...(await channels.recordAutoDisabledIfStopped(r.failed.map((f) => f.id)))];
      }
      if (recorded.length > 0) audit.record('channel.auto_disabled', { target, detail: `${label} 余额 ${usd(balance)} ≤ 0，已停用 ${recorded.length} 个渠道：${idList(recorded)}` });
      if (r.failed.length > 0) {
        audit.record('channel.auto_disable_failed', { target, detail: `${label} 有 ${r.failed.length} 个渠道停用未成功：${idList(r.failed.map((f) => f.id))}；${r.failed[0]!.error}`.slice(0, 500) });
      }
    }

    if (d.restoreIds.length > 0) {
      const r = await channels.setStatus(d.restoreIds, 1, { source: 'auto' });
      if (r.succeeded.length > 0) audit.record('channel.auto_restored', { target, detail: `${label} 余额回升到 ${usd(balance)}，已恢复 ${r.succeeded.length} 个渠道：${idList(r.succeeded)}` });
      if (r.failed.length > 0) {
        audit.record('channel.auto_restore_failed', { target, detail: `${label} 有 ${r.failed.length} 个渠道恢复未成功（下次刷新重试）：${idList(r.failed.map((f) => f.id))}；${r.failed[0]!.error}`.slice(0, 500) });
      }
    }

    if (d.forgetIds.length > 0) {
      await channels.forgetAutoDisabled(d.forgetIds);
      audit.record('channel.auto_record_cleared', { target, detail: `${label} 余额回升；${d.forgetIds.length} 个渠道已被站长改过状态，不再恢复：${idList(d.forgetIds)}` });
    }
  }
}
