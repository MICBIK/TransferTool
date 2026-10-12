import { desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import type { Clock } from './clock.js';

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** detail 只放非敏感的说明（例如被改动的设置项名称），不要放凭证值。 */
  record(action: string, opts: { target?: string; ip?: string; detail?: string } = {}): void {
    this.db
      .insert(auditLog)
      .values({ ts: this.clock(), action, target: opts.target ?? null, ip: opts.ip ?? null, detail: opts.detail ?? null })
      .run();
  }

  recent(limit = 50) {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all();
  }
}
