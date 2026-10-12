import type { BalanceStore } from '../services/balanceStore.js';
import { SNAPSHOT_RETENTION_MS } from '../services/balanceStore.js';
import type { BalanceRefresher } from '../services/balanceRefresher.js';
import type { ChannelService } from '../services/channels.js';
import { SYNC_INTERVAL_MS } from '../services/channels.js';
import type { Clock } from '../services/clock.js';

export const TICK_MS = 60_000;
const CLEANUP_EVERY_MS = 24 * 3600 * 1000;

/**
 * 进程内调度器：每分钟检查一次到期的上游并刷新；启动时立即跑一次；每天清理一次过期快照。
 * 不会重叠：上一轮（或手动刷新）还没结束时，本次 tick 直接跳过。
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastCleanupAt: number | null = null;

  constructor(
    private readonly deps: {
      refresher: BalanceRefresher;
      store: BalanceStore;
      /** 本站渠道同步（每 5 分钟）；缺省时不同步 */
      channels?: ChannelService;
      clock: Clock;
      tickMs?: number;
      log?: (msg: string) => void;
    },
  ) {}

  /** 启动：立即对所有启用的上游刷新一次，然后进入每分钟一次的节拍。 */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick({ force: true });
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  async tick(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopped || this.deps.refresher.busy) return;
    try {
      this.cleanupIfDue();
      await this.syncChannelsIfDue(opts.force === true);
      await this.deps.refresher.run({ force: opts.force });
    } catch (err) {
      // 只记录错误名，避免把含凭证的内容带进日志
      (this.deps.log ?? console.error)(`[scheduler] 本轮刷新出错：${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  /** 先同步渠道，再刷新余额：这样自动归类和“归零停渠道”总能用到较新的渠道列表。 */
  private async syncChannelsIfDue(force: boolean): Promise<void> {
    const channels = this.deps.channels;
    if (!channels || !channels.configured) return;
    const last = channels.lastAttemptAt;
    if (!force && last !== null && this.deps.clock() - last < SYNC_INTERVAL_MS - 10_000) return;
    const r = await channels.sync();
    if (!r.ok && r.error) (this.deps.log ?? console.error)(`[scheduler] 本站渠道同步失败：${r.error}`);
  }

  private cleanupIfDue(): void {
    const now = this.deps.clock();
    if (this.lastCleanupAt !== null && now - this.lastCleanupAt < CLEANUP_EVERY_MS) return;
    this.lastCleanupAt = now;
    const removed = this.deps.store.cleanup(now - SNAPSHOT_RETENTION_MS);
    if (removed > 0) (this.deps.log ?? console.log)(`[scheduler] 已清理 ${removed} 条过期余额快照`);
  }

  /** 停止：不再触发新一轮，中止在途请求并等待当前一轮收尾。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.refresher.shutdown();
    this.deps.channels?.shutdown();
    await this.deps.refresher.idle();
    await this.deps.channels?.idle();
  }
}
