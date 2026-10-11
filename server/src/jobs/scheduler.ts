import type { BalanceStore } from '../services/balanceStore.js';
import { SNAPSHOT_RETENTION_MS } from '../services/balanceStore.js';
import type { BalanceRefresher } from '../services/balanceRefresher.js';
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
      await this.deps.refresher.run({ force: opts.force });
    } catch (err) {
      // 只记录错误名，避免把含凭证的内容带进日志
      (this.deps.log ?? console.error)(`[scheduler] 本轮刷新出错：${err instanceof Error ? err.name : 'unknown'}`);
    }
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
    await this.deps.refresher.idle();
  }
}
