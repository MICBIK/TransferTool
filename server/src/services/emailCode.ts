import { randomInt } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { loginCodes } from '../db/schema.js';
import type { Clock } from './clock.js';
import { hmacHex, safeEqual } from './crypto.js';

export const CODE_TTL_MS = 5 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const HOURLY_LIMIT = 5;
export const MAX_CODE_ATTEMPTS = 5;

export type IssueResult =
  | { ok: true; code: string; id: number }
  | { ok: false; reason: 'too_soon'; retryAfterSeconds: number }
  | { ok: false; reason: 'hourly_limit'; retryAfterSeconds: number };

/** 邮件验证码：6 位数字、5 分钟有效、一次性、只存 HMAC 哈希。 */
export class EmailCodeService {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  private hash(code: string): string {
    return hmacHex(this.secret, 'login-code', code);
  }

  issue(): IssueResult {
    const now = this.clock();
    const lastHour = this.db
      .select()
      .from(loginCodes)
      .where(gt(loginCodes.createdAt, now - 60 * 60 * 1000))
      .orderBy(desc(loginCodes.createdAt))
      .all();

    const latest = lastHour[0];
    if (latest && now - latest.createdAt < RESEND_INTERVAL_MS) {
      return { ok: false, reason: 'too_soon', retryAfterSeconds: Math.ceil((latest.createdAt + RESEND_INTERVAL_MS - now) / 1000) };
    }
    if (lastHour.length >= HOURLY_LIMIT) {
      const oldest = lastHour[HOURLY_LIMIT - 1];
      const retryAt = (oldest?.createdAt ?? now) + 60 * 60 * 1000;
      return { ok: false, reason: 'hourly_limit', retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // 新验证码生效后，之前未使用的全部作废
    this.db.update(loginCodes).set({ used: true }).where(eq(loginCodes.used, false)).run();
    const row = this.db
      .insert(loginCodes)
      .values({ codeHash: this.hash(code), createdAt: now, expiresAt: now + CODE_TTL_MS })
      .returning({ id: loginCodes.id })
      .get();
    return { ok: true, code, id: row.id };
  }

  /** 邮件发送失败时作废刚生成的验证码（仍计入发送频率限制）。 */
  revoke(id: number): void {
    this.db.update(loginCodes).set({ used: true }).where(eq(loginCodes.id, id)).run();
  }

  /** 校验并消耗验证码。同一验证码最多允许 5 次错误尝试，之后作废。 */
  verify(input: string): boolean {
    if (!/^\d{6}$/.test(input)) return false;
    const now = this.clock();
    const row = this.db
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.used, false), gt(loginCodes.expiresAt, now)))
      .orderBy(desc(loginCodes.id))
      .get();
    if (!row) return false;

    if (!safeEqual(this.hash(input), row.codeHash)) {
      const attempts = row.attempts + 1;
      this.db
        .update(loginCodes)
        .set({ attempts, used: attempts >= MAX_CODE_ATTEMPTS })
        .where(eq(loginCodes.id, row.id))
        .run();
      return false;
    }
    // 条件更新保证一次性：并发下只有一个请求能把 used 从 false 改成 true
    const res = this.db
      .update(loginCodes)
      .set({ used: true })
      .where(and(eq(loginCodes.id, row.id), eq(loginCodes.used, false)))
      .run();
    return res.changes === 1;
  }
}
