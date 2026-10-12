import type { LogType, OwnSiteClient, SiteLog } from '../adapters/index.js';
import type { Clock } from './clock.js';
import type { ChannelStatsStore } from './channelStatsStore.js';
import { aggregateLogs, LOG_TYPE_CONSUME, LOG_TYPE_ERROR } from './logAggregate.js';
import type { OwnSiteService } from './ownSite.js';
import type { SettingsStore } from './settings.js';

export const INGEST_INTERVAL_MS = 5 * 60_000;
/** 只拉取“已稳定”的日志：窗口右端 = 现在 - 30 秒 */
export const LAG_SECONDS = 30;
export const FIRST_RUN_LOOKBACK_SECONDS = 3600;
const MAX_LOOKBACK_SECONDS = 30 * 24 * 3600;
export const DEFAULT_PAGE_SIZE = 100;
/** 单轮、单个日志类型最多拉取的页数 */
export const DEFAULT_PAGE_BUDGET = 50;
/** 单个时间秒内的日志极多时的硬上限（页），几乎不可能触及 */
const SINGLE_SECOND_MAX_PAGES = 200;
const MAX_CHUNK_SECONDS = 24 * 3600;
const MAX_BOUNDARY_IDS = 5000;
const MAX_OVERFLOWS_PER_RUN = 3;

const TYPES: LogType[] = [LOG_TYPE_CONSUME, LOG_TYPE_ERROR];

/**
 * 游标状态（存 settings）。窗口是闭区间 [cursor, 现在-30s]；每个分段提交后，cursor = 分段右端 + 1，
 * 因此相邻分段不重叠。boundary 记录分段右端那一秒内已入库的日志 id：万一游标被回拨或本站把区间当成半开处理，
 * 同一秒里已入库的日志也不会被重复计数。
 */
export interface IngestState {
  /** 下次窗口的起点（unix 秒） */
  cursor: number;
  boundary?: { sec: number; ids: Record<string, number[]> };
  /** 上次使用的分段长度（秒），用于超限后保持较小的分段 */
  chunk?: number;
}

export interface IngestResult {
  ok: boolean;
  error: string | null;
  /** 本轮入库的日志条数 */
  ingested: number;
  chunks: number;
  /** 窗口还没追平（页数用完等），尽快继续 */
  backlog: boolean;
}

export interface IngestStatus {
  configured: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  backlog: boolean;
  /** 已入库到的时间点（毫秒）；尚未开始为 null */
  cursorAt: number | null;
}

type FetchOutcome =
  | { kind: 'ok'; logs: SiteLog[]; pages: number }
  | { kind: 'overflow' }
  | { kind: 'defer' }
  | { kind: 'error'; error: string };

/**
 * 本站日志增量聚合。只落聚合（channel_stats），不存原始日志。
 * 分段规则：窗口内某类日志超过“单段上限”（pageBudget 页）时，把时间窗口对半切分，只提交完整拉取的分段，
 * 游标只推进到最后一个完整入库的分段末尾——绝不跳过数据，也不重复计数。
 */
export class LogIngestor {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private running = false;
  lastAttemptAt: number | null = null;
  lastSuccessAt: number | null = null;
  lastError: string | null = null;
  backlog = false;

  private readonly pageSize: number;
  private readonly pageBudget: number;

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      ownSite: OwnSiteService;
      client: OwnSiteClient;
      stats: ChannelStatsStore;
      clock: Clock;
      pageSize?: number;
      pageBudget?: number;
    },
  ) {
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    this.pageBudget = deps.pageBudget ?? DEFAULT_PAGE_BUDGET;
  }

  get configured(): boolean {
    return this.deps.ownSite.connection() !== null;
  }

  get busy(): boolean {
    return this.running;
  }

  shutdown(): void {
    this.abort.abort();
  }

  async idle(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  state(): IngestState | null {
    const raw = this.deps.settings.get('log_ingest_state');
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<IngestState> | null;
      return v && typeof v.cursor === 'number' && Number.isFinite(v.cursor) ? (v as IngestState) : null;
    } catch {
      return null;
    }
  }

  status(): IngestStatus {
    const st = this.state();
    return {
      configured: this.configured,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      backlog: this.backlog,
      cursorAt: st ? st.cursor * 1000 : null,
    };
  }

  /** 单轮拉取。多次调用串行排队，不会并发；任何异常都被记录为 lastError，不会抛出。 */
  run(): Promise<IngestResult> {
    const job = this.tail.then(() => this.guarded());
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async guarded(): Promise<IngestResult> {
    this.running = true;
    try {
      return await this.doRun();
    } catch (err) {
      // 只记录错误名，避免把含凭证的内容带进状态
      const error = `日志拉取内部错误（${err instanceof Error ? err.name : 'unknown'}）`;
      this.lastError = error;
      return { ok: false, error, ingested: 0, chunks: 0, backlog: this.backlog };
    } finally {
      this.running = false;
    }
  }

  private fail(error: string, ingested: number, chunks: number): IngestResult {
    this.lastError = error;
    return { ok: false, error, ingested, chunks, backlog: this.backlog };
  }

  private async doRun(): Promise<IngestResult> {
    const { clock, settings, stats } = this.deps;
    const conn = this.deps.ownSite.connection();
    if (!conn) return { ok: false, error: '尚未配置本站地址与访问令牌', ingested: 0, chunks: 0, backlog: false };
    if (this.abort.signal.aborted) return { ok: false, error: '服务正在关闭', ingested: 0, chunks: 0, backlog: this.backlog };
    this.lastAttemptAt = clock();

    const nowSec = Math.floor(clock() / 1000);
    const end = nowSec - LAG_SECONDS;
    let state = this.state();
    let start = Math.max(state?.cursor ?? nowSec - FIRST_RUN_LOOKBACK_SECONDS, nowSec - MAX_LOOKBACK_SECONDS);
    if (start > end) {
      this.lastError = null;
      this.lastSuccessAt = clock();
      this.backlog = false;
      return { ok: true, error: null, ingested: 0, chunks: 0, backlog: false };
    }

    let len = Math.min(Math.max(1, Math.floor(state?.chunk ?? end - start + 1)), end - start + 1);
    const used: Record<number, number> = { [LOG_TYPE_CONSUME]: 0, [LOG_TYPE_ERROR]: 0 };
    let ingested = 0;
    let chunks = 0;
    let overflows = 0;
    let stalled = false;

    while (start <= end && !stalled) {
      if (this.abort.signal.aborted) return this.fail('服务正在关闭', ingested, chunks);
      if (TYPES.some((t) => used[t]! >= this.pageBudget)) break; // 页数用完：下一轮继续
      const c = Math.min(end, start + len - 1);

      const results: Partial<Record<number, FetchOutcome>> = {};
      for (const type of TYPES) {
        const r = await this.fetchType(conn, type, start, c, this.pageBudget - used[type]!);
        if (r.kind === 'error') {
          this.backlog = true;
          return this.fail(r.error, ingested, chunks);
        }
        results[type] = r;
        if (r.kind !== 'ok') break; // 超限/延后：不必再拉另一类
      }
      const outcomes = TYPES.map((t) => results[t]);
      if (outcomes.some((o) => o?.kind === 'defer')) break;
      if (outcomes.some((o) => o?.kind === 'overflow')) {
        if (start === c) {
          this.backlog = true;
          return this.fail(`${new Date(start * 1000).toISOString()} 这一秒内的日志条数过多，无法完整拉取`, ingested, chunks);
        }
        len = Math.max(1, Math.floor((c - start + 1) / 2));
        if (++overflows >= MAX_OVERFLOWS_PER_RUN) stalled = true;
        // 先把缩小后的分段大小记下来，下一轮从小分段开始
        this.saveState({ cursor: start, boundary: state?.boundary, chunk: len });
        state = this.state();
        continue;
      }

      const logs: SiteLog[] = [];
      const seen = new Set<string>();
      const boundary = state?.boundary;
      const newIds: Record<string, number[]> = { [LOG_TYPE_CONSUME]: [], [LOG_TYPE_ERROR]: [] };
      for (const type of TYPES) {
        const ok = results[type] as Extract<FetchOutcome, { kind: 'ok' }>;
        used[type] = used[type]! + ok.pages;
        for (const l of ok.logs) {
          if (l.type !== type) continue; // 防御：本站忽略了 type 参数时不串类型
          if (l.createdAt < start || l.createdAt > c) continue;
          if (l.id !== null) {
            const key = `${type}:${l.id}`;
            if (seen.has(key)) continue; // 翻页期间的偏移导致的重复
            seen.add(key);
            if (boundary && l.createdAt === boundary.sec && boundary.ids[String(type)]?.includes(l.id)) continue;
            if (l.createdAt === c && newIds[String(type)]!.length < MAX_BOUNDARY_IDS) newIds[String(type)]!.push(l.id);
          }
          logs.push(l);
        }
      }
      const aggs = aggregateLogs(logs, [conn.token]);
      const next: IngestState = { cursor: c + 1, boundary: { sec: c, ids: newIds }, chunk: Math.min(len * 2, MAX_CHUNK_SECONDS) };
      stats.apply(aggs, () => settings.set('log_ingest_state', JSON.stringify(next)));
      ingested += logs.length;
      chunks++;
      state = next;
      start = c + 1;
      len = Math.min(len * 2, MAX_CHUNK_SECONDS, Math.max(1, end - start + 1));
    }

    this.backlog = start <= end;
    this.lastError = null;
    this.lastSuccessAt = clock();
    return { ok: true, error: null, ingested, chunks, backlog: this.backlog };
  }

  private saveState(s: IngestState): void {
    this.deps.settings.set('log_ingest_state', JSON.stringify(s));
  }

  /** 拉取 [s, c] 内某一类的全部日志；超过单段上限返回 overflow，超过本轮剩余页数返回 defer。 */
  private async fetchType(conn: NonNullable<ReturnType<OwnSiteService['connection']>>, type: LogType, s: number, c: number, budgetLeft: number): Promise<FetchOutcome> {
    const hardCap = s === c ? SINGLE_SECOND_MAX_PAGES : this.pageBudget;
    // 单秒窗口无法再切分，不受本轮页数预算限制
    const limit = s === c ? hardCap : Math.min(hardCap, budgetLeft);
    const logs: SiteLog[] = [];
    let total: number | undefined;
    let raw = 0;
    for (let page = 1; ; page++) {
      if (this.abort.signal.aborted) return { kind: 'error', error: '服务正在关闭' };
      const r = await this.deps.client.listLogs(conn, { type, start: s, end: c, page, pageSize: this.pageSize }, { signal: this.abort.signal });
      if (!r.ok) return { kind: 'error', error: r.error };
      if (page === 1 && r.total !== undefined) {
        total = r.total;
        const needed = Math.ceil(total / this.pageSize);
        if (needed > hardCap) return { kind: 'overflow' };
        if (needed > limit) return { kind: 'defer' };
      }
      logs.push(...r.logs);
      raw += r.rawCount;
      if (r.rawCount === 0) return { kind: 'ok', logs, pages: page };
      if (total !== undefined ? raw >= total : r.rawCount < this.pageSize) return { kind: 'ok', logs, pages: page };
      if (page >= limit) return limit < hardCap ? { kind: 'defer' } : { kind: 'overflow' };
    }
  }
}
