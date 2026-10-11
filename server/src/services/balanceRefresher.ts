import type { BalanceResult, createAdapters } from '../adapters/index.js';
import type { AlertCandidate, AlertService } from './alertService.js';
import type { BalanceStore } from './balanceStore.js';
import type { Clock } from './clock.js';
import type { UpstreamRow, UpstreamService } from './upstreams.js';
import { upstreams } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export const DEFAULT_CONCURRENCY = 5;
/** 调度每分钟检查一次，留一点抖动余量，避免 10 分钟间隔变成 11 分钟 */
const DUE_SLACK_MS = 10_000;

export interface RefreshOptions {
  /** 只刷新这些上游（手动刷新）；缺省为所有“到期”的启用上游 */
  ids?: number[];
  /** 忽略到期判断（启动时、手动刷新） */
  force?: boolean;
}

export interface RefreshSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  alertsSent: number;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * 拉取余额、写快照、更新失败计数，并在一轮结束后统一做提醒判定（同轮多个跌破合并成一封邮件）。
 * run() 之间严格串行：调度器与手动刷新不会重叠执行。
 */
export class BalanceRefresher {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly deps: {
      db: Db;
      upstreams: UpstreamService;
      store: BalanceStore;
      adapters: ReturnType<typeof createAdapters>;
      alerts: AlertService;
      clock: Clock;
      concurrency?: number;
    },
  ) {}

  get busy(): boolean {
    return this.pending > 0;
  }

  /** 进程关闭：中止所有在途请求，之后的 run 直接返回空结果。 */
  shutdown(): void {
    this.abort.abort();
  }

  /** 等待排队/在途的 run 全部结束。 */
  async idle(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  run(opts: RefreshOptions = {}): Promise<RefreshSummary> {
    this.pending++;
    const job = this.tail.then(() => this.doRun(opts)).finally(() => void this.pending--);
    this.tail = job.catch(() => undefined);
    return job;
  }

  private dueRows(opts: RefreshOptions): UpstreamRow[] {
    const now = this.deps.clock();
    let rows = this.deps.upstreams.list().filter((r) => r.enabled);
    if (opts.ids) rows = rows.filter((r) => opts.ids!.includes(r.id));
    if (!opts.force && !opts.ids) {
      rows = rows.filter((r) => r.lastCheckedAt === null || now - r.lastCheckedAt >= r.intervalMinutes * 60_000 - DUE_SLACK_MS);
    }
    return rows;
  }

  private async doRun(opts: RefreshOptions): Promise<RefreshSummary> {
    const summary: RefreshSummary = { attempted: 0, succeeded: 0, failed: 0, alertsSent: 0 };
    if (this.abort.signal.aborted) return summary;
    const rows = this.dueRows(opts);
    const candidates: AlertCandidate[] = [];

    await mapLimit(rows, this.deps.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
      const result = await this.fetchOne(row);
      if (this.abort.signal.aborted) return; // 关闭中途的结果可能是被中止的半成品，丢弃
      const counted = this.record(row, result);
      if (!counted) return; // 刷新期间该上游已被删除
      summary.attempted++;
      if (result.ok) summary.succeeded++;
      else if (!result.unsupported) summary.failed++;
      candidates.push({
        upstream: counted,
        balanceUsd: result.ok && result.balanceUsd !== undefined ? result.balanceUsd : null,
        keyLimit: result.kind === 'key_limit',
      });
    });

    if (candidates.length > 0 && !this.abort.signal.aborted) {
      summary.alertsSent = (await this.deps.alerts.process(candidates)).sent;
    }
    return summary;
  }

  private async fetchOne(row: UpstreamRow): Promise<BalanceResult> {
    let adapterUpstream;
    try {
      adapterUpstream = this.deps.upstreams.toAdapterUpstream(row);
    } catch {
      return { ok: false, mode: 'unknown', error: '无法解密已保存的凭证（ENCRYPTION_KEY 是否更换过？），请重新填写' };
    }
    return this.deps.adapters.fetchBalance(adapterUpstream, { signal: this.abort.signal });
  }

  /** 写快照并更新失败计数，返回最新的上游行。订阅制既非成功也非失败，不累计失败次数。 */
  private record(row: UpstreamRow, result: BalanceResult): UpstreamRow | null {
    const now = this.deps.clock();
    const current = this.deps.upstreams.find(row.id);
    if (!current) return null;
    this.deps.store.insertSnapshot(row.id, now, result);
    const failures = result.ok || result.unsupported ? 0 : current.consecutiveFailures + 1;
    return this.deps.db.update(upstreams).set({ lastCheckedAt: now, consecutiveFailures: failures }).where(eq(upstreams.id, row.id)).returning().get() ?? null;
  }
}
