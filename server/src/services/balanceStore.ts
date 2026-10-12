import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { alerts, balanceSnapshots } from '../db/schema.js';
import type { BalanceResult } from '../adapters/index.js';
import type { AlertRecord } from './alertMachine.js';
import type { BalancePoint } from './burnRate.js';

export type SnapshotRow = typeof balanceSnapshots.$inferSelect;

export const SNAPSHOT_RETENTION_MS = 90 * 24 * 3600 * 1000;

/** balance_snapshots 与 alerts 两张表的读写。 */
export class BalanceStore {
  constructor(private readonly db: Db) {}

  insertSnapshot(upstreamId: number, ts: number, r: BalanceResult): void {
    this.db
      .insert(balanceSnapshots)
      .values({
        upstreamId,
        ts,
        balanceUsd: r.ok && r.balanceUsd !== undefined ? r.balanceUsd : null,
        mode: r.mode,
        ok: r.ok,
        error: r.error ?? null,
        raw: r.raw ? JSON.stringify(r.raw) : null,
      })
      .run();
  }

  latest(upstreamId: number): SnapshotRow | undefined {
    return this.db.select().from(balanceSnapshots).where(eq(balanceSnapshots.upstreamId, upstreamId)).orderBy(desc(balanceSnapshots.ts), desc(balanceSnapshots.id)).limit(1).get();
  }

  latestSuccess(upstreamId: number): SnapshotRow | undefined {
    return this.db
      .select()
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.upstreamId, upstreamId), eq(balanceSnapshots.ok, true)))
      .orderBy(desc(balanceSnapshots.ts), desc(balanceSnapshots.id))
      .limit(1)
      .get();
  }

  /** 成功快照（升序），用于曲线与消耗速度。 */
  points(upstreamId: number, since: number): BalancePoint[] {
    return this.db
      .select({ ts: balanceSnapshots.ts, balanceUsd: balanceSnapshots.balanceUsd })
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.upstreamId, upstreamId), eq(balanceSnapshots.ok, true), gte(balanceSnapshots.ts, since)))
      .orderBy(asc(balanceSnapshots.ts))
      .all()
      .flatMap((r) => (r.balanceUsd === null ? [] : [{ ts: r.ts, balanceUsd: r.balanceUsd }]));
  }

  cleanup(before: number): number {
    return this.db.delete(balanceSnapshots).where(lt(balanceSnapshots.ts, before)).run().changes;
  }

  getAlert(upstreamId: number): (AlertRecord & { lastResult: string | null }) | undefined {
    const row = this.db.select().from(alerts).where(eq(alerts.upstreamId, upstreamId)).get();
    return row ? { state: row.state, lastSentAt: row.lastSentAt, lastResult: row.lastResult } : undefined;
  }

  saveAlert(upstreamId: number, rec: AlertRecord, lastResult: string | null, now: number): void {
    this.db
      .insert(alerts)
      .values({ upstreamId, state: rec.state, lastSentAt: rec.lastSentAt, lastResult, updatedAt: now })
      .onConflictDoUpdate({ target: alerts.upstreamId, set: { state: rec.state, lastSentAt: rec.lastSentAt, lastResult, updatedAt: now } })
      .run();
  }

  setAlertResult(upstreamId: number, lastResult: string, now: number): void {
    this.db.update(alerts).set({ lastResult, updatedAt: now }).where(eq(alerts.upstreamId, upstreamId)).run();
  }
}
