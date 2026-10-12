import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ChannelStatus, ChannelTestResult, OwnSiteClient, SiteErrorKind, StatusManyResult } from '../adapters/index.js';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { AuditService } from './audit.js';
import { classifyChannel, suggestUpstreams, type UpstreamSuggestion } from './channelClassifier.js';
import type { Clock } from './clock.js';
import type { OwnSiteService } from './ownSite.js';
import { parseDomains, type UpstreamService } from './upstreams.js';

export const SITE_ID = 1;
export const SYNC_INTERVAL_MS = 5 * 60_000;

export type ChannelRow = typeof channels.$inferSelect;

export const statusBodySchema = z.strictObject({ status: z.union([z.literal(1), z.literal(2)]) });
export const batchStatusBodySchema = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  status: z.union([z.literal(1), z.literal(2)]),
});
export const assignBodySchema = z.strictObject({ upstreamId: z.number().int().positive().nullable() });

/** 面向用户的渠道操作失败（消息可直接展示，不含凭证）。 */
export class ChannelError extends Error {
  constructor(
    readonly code: 'not_configured' | 'not_found' | 'invalid' | 'site_error' | 'site_scope_denied',
    message: string,
  ) {
    super(message);
  }
}

export interface ChannelView {
  id: number;
  name: string;
  type: number;
  baseUrl: string;
  groups: string[];
  status: number;
  priority: number;
  weight: number;
  responseTimeMs: number;
  tag: string;
  upstreamId: number | null;
  manualUpstream: boolean;
  /** 是本工具因余额归零停用的（余额恢复后会自动恢复） */
  autoDisabled: boolean;
  syncedAt: number;
}

export interface SyncSummary {
  ok: boolean;
  error: string | null;
  total: number;
  added: number;
  removed: number;
  syncedAt: number | null;
}

export interface StatusChangeResult extends StatusManyResult {
  requested: number;
}

function parseGroups(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const SITE_KIND: Record<SiteErrorKind, ChannelError['code']> = { scope: 'site_scope_denied', auth: 'site_error', network: 'site_error', unsupported: 'site_error', notfound: 'site_error', business: 'site_error', http: 'site_error' };

/**
 * 本站渠道缓存：同步、归类、启停、测试。
 * 同步与写操作经同一队列串行（exclusive），避免“刚改完状态又被旧的列表覆盖”。
 */
export class ChannelService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  lastAttemptAt: number | null = null;
  lastSyncAt: number | null = null;
  lastError: string | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      ownSite: OwnSiteService;
      client: OwnSiteClient;
      upstreams: UpstreamService;
      audit: AuditService;
      clock: Clock;
    },
  ) {}

  get configured(): boolean {
    return this.deps.ownSite.connection() !== null;
  }

  shutdown(): void {
    this.abort.abort();
  }

  async idle(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const job = this.tail.then(fn);
    this.tail = job.catch(() => undefined);
    return job;
  }

  private conn() {
    const conn = this.deps.ownSite.connection();
    if (!conn) throw new ChannelError('not_configured', '尚未配置本站地址与访问令牌，请先到“设置”页填写');
    return conn;
  }

  private fail(r: { kind: SiteErrorKind; error: string }): never {
    throw new ChannelError(SITE_KIND[r.kind], r.error);
  }

  // ---- 读取 ----

  rows(): ChannelRow[] {
    return this.deps.db.select().from(channels).where(eq(channels.siteId, SITE_ID)).orderBy(asc(channels.channelId)).all();
  }

  rowsForUpstream(upstreamId: number): ChannelRow[] {
    return this.deps.db.select().from(channels).where(and(eq(channels.siteId, SITE_ID), eq(channels.upstreamId, upstreamId))).orderBy(asc(channels.channelId)).all();
  }

  find(channelId: number): ChannelRow | undefined {
    return this.deps.db.select().from(channels).where(and(eq(channels.siteId, SITE_ID), eq(channels.channelId, channelId))).get();
  }

  view(r: ChannelRow): ChannelView {
    return {
      id: r.channelId,
      name: r.name,
      type: r.type,
      baseUrl: r.baseUrl,
      groups: parseGroups(r.groups),
      status: r.status,
      priority: r.priority,
      weight: r.weight,
      responseTimeMs: r.responseTime,
      tag: r.tag,
      upstreamId: r.upstreamId,
      manualUpstream: r.manualUpstream,
      autoDisabled: r.autoDisabledAt !== null,
      syncedAt: r.syncedAt,
    };
  }

  views(): ChannelView[] {
    return this.rows().map((r) => this.view(r));
  }

  /** 每个上游的启用/总数；upstreamId 为 null 的是未归类渠道。 */
  summary(): { upstreamId: number | null; enabled: number; total: number }[] {
    const acc = new Map<number | null, { enabled: number; total: number }>();
    for (const r of this.rows()) {
      const e = acc.get(r.upstreamId) ?? { enabled: 0, total: 0 };
      e.total++;
      if (r.status === 1) e.enabled++;
      acc.set(r.upstreamId, e);
    }
    return [...acc].map(([upstreamId, v]) => ({ upstreamId, ...v }));
  }

  /** 未归类渠道按主域名分组，给出可一键添加的上游建议。 */
  upstreamSuggestions(): UpstreamSuggestion[] {
    return suggestUpstreams(this.rows().filter((r) => r.upstreamId === null));
  }

  // ---- 同步与归类 ----

  private domainsTable() {
    return this.deps.upstreams.list().map((u) => ({ id: u.id, domains: parseDomains(u.matchDomains) }));
  }

  /** 从本站拉取全部渠道并写入缓存；失败时缓存原样保留（不会因一次失败而清空）。 */
  sync(): Promise<SyncSummary> {
    return this.exclusive(() => this.doSync());
  }

  private async doSync(): Promise<SyncSummary> {
    const { db, clock } = this.deps;
    const summary = (over: Partial<SyncSummary>): SyncSummary => ({ ok: false, error: null, total: this.rows().length, added: 0, removed: 0, syncedAt: this.lastSyncAt, ...over });
    const conn = this.deps.ownSite.connection();
    if (!conn) return summary({ error: '尚未配置本站地址与访问令牌' });
    if (this.abort.signal.aborted) return summary({ error: '服务正在关闭' });

    this.lastAttemptAt = clock();
    const res = await this.deps.client.listChannels(conn, { signal: this.abort.signal });
    if (this.abort.signal.aborted) return summary({ error: '服务正在关闭' });
    if (!res.ok) {
      this.lastError = res.error;
      return summary({ error: res.error });
    }

    const now = clock();
    const domains = this.domainsTable();
    const known = new Set(domains.map((d) => d.id));
    let added = 0;
    let removed = 0;
    db.transaction((tx) => {
      const existing = new Map(tx.select().from(channels).where(eq(channels.siteId, SITE_ID)).all().map((r) => [r.channelId, r]));
      const seen = new Set<number>();
      for (const c of res.channels) {
        seen.add(c.id);
        const prev = existing.get(c.id);
        if (!prev) added++;
        // 手动指定优先且不被覆盖；指定的上游已被删除时退回自动归类
        const keepManual = prev?.manualUpstream === true && prev.upstreamId !== null && known.has(prev.upstreamId);
        const upstreamId = keepManual ? prev.upstreamId : classifyChannel(c.baseUrl, domains);
        // 站长在本站把它重新启用/改了状态：不再视为“本工具停的”
        const autoDisabledAt = prev && c.status === 2 ? prev.autoDisabledAt : null;
        const values = {
          siteId: SITE_ID,
          channelId: c.id,
          name: c.name,
          type: c.type,
          baseUrl: c.baseUrl,
          groups: JSON.stringify(c.groups),
          status: c.status,
          priority: c.priority,
          weight: c.weight,
          responseTime: c.responseTime,
          tag: c.tag,
          upstreamId,
          manualUpstream: keepManual,
          autoDisabledAt,
          syncedAt: now,
        };
        tx.insert(channels).values(values).onConflictDoUpdate({ target: [channels.siteId, channels.channelId], set: values }).run();
      }
      const gone = [...existing.keys()].filter((id) => !seen.has(id));
      removed = gone.length;
      for (let i = 0; i < gone.length; i += 500) {
        tx.delete(channels).where(and(eq(channels.siteId, SITE_ID), inArray(channels.channelId, gone.slice(i, i + 500)))).run();
      }
    });
    this.lastSyncAt = now;
    this.lastError = null;
    return { ok: true, error: null, total: res.channels.length, added, removed, syncedAt: now };
  }

  /** 上游新增/修改匹配域名后立即重新归类（不访问本站）；手动指定的不动。 */
  reclassify(): Promise<void> {
    return this.exclusive(() => {
      const domains = this.domainsTable();
      this.deps.db.transaction((tx) => {
        for (const r of tx.select().from(channels).where(eq(channels.siteId, SITE_ID)).all()) {
          // 手动指定且上游仍在的不动；上游已被删除（外键置空）的退回自动归类
          if (r.manualUpstream && r.upstreamId !== null) continue;
          const upstreamId = classifyChannel(r.baseUrl, domains);
          if (upstreamId !== r.upstreamId || r.manualUpstream) {
            tx.update(channels).set({ upstreamId, manualUpstream: false }).where(and(eq(channels.siteId, SITE_ID), eq(channels.channelId, r.channelId))).run();
          }
        }
      });
    });
  }

  /** 手动指定上游；null = 取消手动指定，恢复自动归类。 */
  assignUpstream(channelId: number, upstreamId: number | null, ip?: string): Promise<ChannelView> {
    return this.exclusive(() => {
      const row = this.find(channelId);
      if (!row) throw new ChannelError('not_found', '渠道不存在（可能已在本站删除，请先同步）');
      if (upstreamId !== null && !this.deps.upstreams.find(upstreamId)) throw new ChannelError('invalid', '上游不存在');
      const set = upstreamId === null ? { manualUpstream: false, upstreamId: classifyChannel(row.baseUrl, this.domainsTable()) } : { manualUpstream: true, upstreamId };
      const fresh = this.deps.db
        .update(channels)
        .set(set)
        .where(and(eq(channels.siteId, SITE_ID), eq(channels.channelId, channelId)))
        .returning()
        .get();
      this.deps.audit.record('channel.upstream_assigned', { target: `channel:${channelId}`, ip, detail: upstreamId === null ? '恢复自动归类' : `upstream:${upstreamId}` });
      return this.view(fresh);
    });
  }

  // ---- 启停与测试 ----

  /**
   * 启停若干渠道并更新缓存。source='auto' 且 status=2 时记录“本工具停用”；
   * 其余情况（包括任何手动操作）都会清除该记录——手动操作接管之后，不会再被自动恢复。
   */
  setStatus(ids: number[], status: ChannelStatus, opts: { source: 'manual' | 'auto'; ip?: string }): Promise<StatusChangeResult> {
    return this.exclusive(async () => {
      const conn = this.conn();
      const unique = [...new Set(ids)];
      const known = new Set(this.rows().filter((r) => unique.includes(r.channelId)).map((r) => r.channelId));
      const missing = unique.filter((id) => !known.has(id));
      const todo = unique.filter((id) => known.has(id));
      let result: StatusManyResult = { succeeded: [], failed: [] };
      if (todo.length === 1) {
        const r = await this.deps.client.setStatus(conn, todo[0]!, status, { signal: this.abort.signal });
        result = r.ok ? { succeeded: todo, failed: [] } : { succeeded: [], failed: [{ id: todo[0]!, error: r.error }] };
      } else if (todo.length > 1) {
        result = await this.deps.client.setStatusMany(conn, todo, status, { signal: this.abort.signal });
      }
      for (const id of missing) result.failed.push({ id, error: '渠道不存在（可能已在本站删除，请先同步）' });

      if (result.succeeded.length > 0) {
        this.deps.db
          .update(channels)
          .set({ status, autoDisabledAt: opts.source === 'auto' && status === 2 ? this.deps.clock() : null })
          .where(and(eq(channels.siteId, SITE_ID), inArray(channels.channelId, result.succeeded)))
          .run();
      }
      if (opts.source === 'manual') {
        const action = status === 1 ? '启用' : '停用';
        this.deps.audit.record(unique.length === 1 ? 'channel.status_changed' : 'channel.batch_status_changed', {
          target: unique.length === 1 ? `channel:${unique[0]}` : undefined,
          ip: opts.ip,
          detail: `${action}：成功 ${result.succeeded.length}，失败 ${result.failed.length}${unique.length > 1 ? `；ids=${unique.slice(0, 50).join(',')}` : ''}`,
        });
      }
      return { ...result, requested: unique.length };
    });
  }

  /** 一键启停某上游的渠道。停用：所有启用中的；启用：所有手动停用的（本站自动禁用的不动）。 */
  setUpstreamStatus(upstreamId: number, status: ChannelStatus, ip?: string): Promise<StatusChangeResult> {
    if (!this.deps.upstreams.find(upstreamId)) throw new ChannelError('not_found', '上游不存在');
    const ids = this.rowsForUpstream(upstreamId)
      .filter((r) => (status === 2 ? r.status === 1 : r.status === 2))
      .map((r) => r.channelId);
    if (ids.length === 0) return Promise.resolve({ succeeded: [], failed: [], requested: 0 });
    return this.setStatus(ids, status, { source: 'manual', ip });
  }

  /** 部分失败后，把确实已处于“手动禁用”的渠道补记为本工具停用（先重新同步确认）。 */
  async recordAutoDisabledIfStopped(ids: number[]): Promise<number[]> {
    const sync = await this.sync();
    if (!sync.ok) return [];
    return this.exclusive(() => {
      const now = this.deps.clock();
      const stopped = this.rows().filter((r) => ids.includes(r.channelId) && r.status === 2).map((r) => r.channelId);
      if (stopped.length > 0) {
        this.deps.db.update(channels).set({ autoDisabledAt: now }).where(and(eq(channels.siteId, SITE_ID), inArray(channels.channelId, stopped))).run();
      }
      return stopped;
    });
  }

  /** 清除“本工具停用”记录（不动渠道状态）。 */
  forgetAutoDisabled(ids: number[]): Promise<void> {
    return this.exclusive(() => {
      if (ids.length === 0) return;
      this.deps.db.update(channels).set({ autoDisabledAt: null }).where(and(eq(channels.siteId, SITE_ID), inArray(channels.channelId, ids))).run();
    });
  }

  /** 触发本站对该渠道做一次测试。不排队（可能耗时较长），也不改缓存里的启停状态。 */
  async test(channelId: number): Promise<ChannelTestResult> {
    const conn = this.conn();
    if (!this.find(channelId)) throw new ChannelError('not_found', '渠道不存在（可能已在本站删除，请先同步）');
    const r = await this.deps.client.testChannel(conn, channelId, { signal: this.abort.signal });
    if (!r.ok) this.fail(r);
    if (r.result.passed && r.result.timeSeconds !== null) {
      this.deps.db.update(channels).set({ responseTime: Math.round(r.result.timeSeconds * 1000) }).where(and(eq(channels.siteId, SITE_ID), eq(channels.channelId, channelId))).run();
    }
    return r.result;
  }
}
