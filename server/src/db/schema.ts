import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/**
 * 上游（new-api / sub2api）。凭证、用户 ID、账号、密码以 enc:v1: 密文存储。
 * 金额一律按美元；threshold 等阈值是“换算后的 USD”。
 */
export const upstreams = sqliteTable('upstreams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: ['newapi', 'sub2api'] }).notNull(),
  siteUrl: text('site_url').notNull(),
  /** JSON 字符串数组：用于阶段 3 把渠道 base_url 归类到该上游 */
  matchDomains: text('match_domains').notNull().default('[]'),
  topupUrl: text('topup_url'),
  threshold: real('threshold').notNull(),
  emergencyThreshold: real('emergency_threshold'),
  intervalMinutes: integer('interval_minutes').notNull().default(10),
  rateFactor: real('rate_factor').notNull().default(1),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  note: text('note').notNull().default(''),
  credentialEnc: text('credential_enc').notNull(),
  userIdEnc: text('user_id_enc'),
  accountEnc: text('account_enc'),
  passwordEnc: text('password_enc'),
  /** 调度状态：最近一次尝试时间与连续失败次数（>=3 视为“余额未知”） */
  lastCheckedAt: integer('last_checked_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** 每次刷新一行（成功或失败）。保留 90 天。 */
export const balanceSnapshots = sqliteTable(
  'balance_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    upstreamId: integer('upstream_id')
      .notNull()
      .references(() => upstreams.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    balanceUsd: real('balance_usd'),
    mode: text('mode').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    error: text('error'),
    /** 原始额度字段（JSON，仅数值/模式类字段，不含任何凭证） */
    raw: text('raw'),
  },
  (t) => [index('balance_snapshots_upstream_ts_idx').on(t.upstreamId, t.ts)],
);

/** 提醒状态机的持久化状态，每个上游一行。 */
export const alerts = sqliteTable('alerts', {
  upstreamId: integer('upstream_id')
    .primaryKey()
    .references(() => upstreams.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['normal', 'low', 'critical'] }).notNull().default('normal'),
  lastSentAt: integer('last_sent_at'),
  lastResult: text('last_result'),
  updatedAt: integer('updated_at').notNull(),
});
