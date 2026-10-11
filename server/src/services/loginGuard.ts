import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { loginAttempts } from '../db/schema.js';
import type { Clock } from './clock.js';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

export interface GuardStatus {
  locked: boolean;
  /** 仍需等待的秒数（locked 时有意义） */
  retryAfterSeconds: number;
}

/** 按 IP 防暴力破解：连续失败 5 次锁 15 分钟，密码与验证码共用计数。 */
export class LoginGuard {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  check(ip: string): GuardStatus {
    const row = this.db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip)).get();
    const now = this.clock();
    if (row && row.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((row.lockedUntil - now) / 1000) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  /** 记录一次失败；返回本次失败后是否进入锁定。 */
  recordFailure(ip: string): GuardStatus {
    const now = this.clock();
    const row = this.db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip)).get();
    // 距上次失败超过锁定时长则视为不再“连续”，重新计数
    const previous = row && now - row.lastFailureAt < LOCK_MS ? row.failures : 0;
    const failures = previous + 1;
    const lockNow = failures >= MAX_FAILURES;
    const next = {
      failures: lockNow ? 0 : failures,
      lastFailureAt: now,
      lockedUntil: lockNow ? now + LOCK_MS : (row?.lockedUntil ?? 0),
    };
    this.db
      .insert(loginAttempts)
      .values({ ip, ...next })
      .onConflictDoUpdate({ target: loginAttempts.ip, set: next })
      .run();
    return lockNow ? { locked: true, retryAfterSeconds: LOCK_MS / 1000 } : { locked: false, retryAfterSeconds: 0 };
  }

  recordSuccess(ip: string): void {
    this.db.delete(loginAttempts).where(eq(loginAttempts.ip, ip)).run();
  }
}
