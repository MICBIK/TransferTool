import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channelStats } from '../db/schema.js';
import type { StatBucket } from './channelHealth.js';
import { mergeSamples, parseSamples, type BucketAgg } from './logAggregate.js';

export const STATS_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const STATS_SITE_ID = 1;

/** channel_stats 的读写。写入是“合并”：与已有桶相加，错误样本合并后保留 Top 5。 */
export class ChannelStatsStore {
  constructor(private readonly db: Db) {}

  /** 在同一个事务里合并桶并执行 inTx（用来原子地推进游标）。 */
  apply(aggs: BucketAgg[], inTx?: () => void): void {
    this.db.transaction((tx) => {
      for (const a of aggs) {
        const cur = tx
          .select()
          .from(channelStats)
          .where(and(eq(channelStats.siteId, STATS_SITE_ID), eq(channelStats.channelId, a.channelId), eq(channelStats.bucketStart, a.bucketStart)))
          .get();
        const values = {
          siteId: STATS_SITE_ID,
          channelId: a.channelId,
          bucketStart: a.bucketStart,
          requests: (cur?.requests ?? 0) + a.requests,
          errors: (cur?.errors ?? 0) + a.errors,
          totalUseTime: (cur?.totalUseTime ?? 0) + a.totalUseTime,
          errorSamples: JSON.stringify(mergeSamples(parseSamples(cur?.errorSamples ?? '[]'), a.samples)),
          lastSuccessAt: Math.max(cur?.lastSuccessAt ?? 0, a.lastSuccessAt ?? 0) || null,
        };
        tx.insert(channelStats).values(values).onConflictDoUpdate({ target: [channelStats.siteId, channelStats.channelId, channelStats.bucketStart], set: values }).run();
      }
      inTx?.();
    });
  }

  /** 自 since（毫秒，按桶起点）以来的全部桶，按渠道分组。 */
  since(since: number): Map<number, StatBucket[]> {
    const rows = this.db.select().from(channelStats).where(and(eq(channelStats.siteId, STATS_SITE_ID), gt(channelStats.bucketStart, since))).all();
    const out = new Map<number, StatBucket[]>();
    for (const r of rows) {
      const list = out.get(r.channelId) ?? [];
      list.push({ bucketStart: r.bucketStart, requests: r.requests, errors: r.errors, totalUseTime: r.totalUseTime, errorSamples: r.errorSamples, lastSuccessAt: r.lastSuccessAt });
      out.set(r.channelId, list);
    }
    return out;
  }

  cleanup(before: number): number {
    return this.db.delete(channelStats).where(lt(channelStats.bucketStart, before)).run().changes;
  }
}
