import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 键值设置。敏感项以 enc:v1: 密文存储（encrypted=1）。 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

/** 单行表（id 恒为 1）：站长密码哈希与会话版本号。 */
export const auth = sqliteTable('auth', {
  id: integer('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  sessionVersion: integer('session_version').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
});

/** 邮件验证码：只存 HMAC 哈希。时间均为毫秒时间戳。 */
export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    codeHash: text('code_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    used: integer('used', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('login_codes_created_idx').on(t.createdAt)],
);

/** 按 IP 的连续失败计数与锁定截止时间。 */
export const loginAttempts = sqliteTable('login_attempts', {
  ip: text('ip').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lastFailureAt: integer('last_failure_at').notNull().default(0),
  lockedUntil: integer('locked_until').notNull().default(0),
});

/** 审计日志：敏感操作与登录事件。detail 中不得出现任何凭证。 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    detail: text('detail'),
  },
  (t) => [index('audit_log_ts_idx').on(t.ts)],
);
