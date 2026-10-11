import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeDomain, normalizeOptionalUrl, normalizeSiteUrl, UrlError, type AdapterUpstream, type BalanceResult, type createAdapters } from '../adapters/index.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { alerts, upstreams } from '../db/schema.js';
import { MASK } from './adminSettings.js';
import type { AuditService } from './audit.js';
import type { BalanceStore } from './balanceStore.js';
import { BURN_WINDOW_MS, estimateBurn } from './burnRate.js';
import type { Clock } from './clock.js';
import { decrypt, encrypt } from './crypto.js';

export type UpstreamRow = typeof upstreams.$inferSelect;
export type SecretField = 'credential' | 'userId' | 'account' | 'password';
export const SECRET_FIELDS: readonly SecretField[] = ['credential', 'userId', 'account', 'password'];

/** 连续失败达到该次数后，余额标记为“未知” */
export const UNKNOWN_AFTER_FAILURES = 3;

export class UpstreamValidationError extends Error {}
export class UpstreamNotFoundError extends Error {}

const money = z.number().finite().min(0).max(1e9);
const shape = {
  name: z.string().trim().min(1).max(100),
  type: z.enum(['newapi', 'sub2api']),
  siteUrl: z.string().trim().min(1).max(2048),
  matchDomains: z.array(z.string().max(255)).max(20),
  topupUrl: z.string().trim().max(2048),
  threshold: money,
  emergencyThreshold: money.nullable(),
  intervalMinutes: z.number().int().min(1).max(1440),
  rateFactor: z.number().finite().gt(0).max(1000),
  enabled: z.boolean(),
  note: z.string().max(500),
  userId: z.string().trim().regex(/^\d{1,12}$/, '用户 ID 必须是数字').or(z.literal('')),
  account: z.string().max(256),
  password: z.string().max(512),
};

export const createUpstreamSchema = z.strictObject({
  name: shape.name,
  type: shape.type,
  siteUrl: shape.siteUrl,
  threshold: shape.threshold,
  credential: z.string().trim().min(1).max(2048),
  matchDomains: shape.matchDomains.optional(),
  topupUrl: shape.topupUrl.optional(),
  emergencyThreshold: shape.emergencyThreshold.optional(),
  intervalMinutes: shape.intervalMinutes.optional(),
  rateFactor: shape.rateFactor.optional(),
  enabled: shape.enabled.optional(),
  note: shape.note.optional(),
  userId: shape.userId.optional(),
  account: shape.account.optional(),
  password: shape.password.optional(),
});
export type CreateUpstreamInput = z.infer<typeof createUpstreamSchema>;

/** 编辑：所有字段可选；敏感字段留空或回传掩码 = 不修改。 */
export const updateUpstreamSchema = z.strictObject({
  name: shape.name.optional(),
  siteUrl: shape.siteUrl.optional(),
  threshold: shape.threshold.optional(),
  credential: z.string().max(2048).optional(),
  matchDomains: shape.matchDomains.optional(),
  topupUrl: shape.topupUrl.optional(),
  emergencyThreshold: shape.emergencyThreshold.optional(),
  intervalMinutes: shape.intervalMinutes.optional(),
  rateFactor: shape.rateFactor.optional(),
  enabled: shape.enabled.optional(),
  note: shape.note.optional(),
  userId: shape.userId.optional(),
  account: shape.account.optional(),
  password: shape.password.optional(),
});
export type UpdateUpstreamInput = z.infer<typeof updateUpstreamSchema>;

/** “测试连接”：不落库。编辑场景下带 id，留空的敏感字段沿用库里的值。 */
export const testUpstreamSchema = z.strictObject({
  id: z.number().int().positive().optional(),
  type: shape.type,
  siteUrl: shape.siteUrl,
  credential: z.string().max(2048).optional(),
  userId: shape.userId.optional(),
  rateFactor: shape.rateFactor.optional(),
});
export type TestUpstreamInput = z.infer<typeof testUpstreamSchema>;

export type UpstreamStatus = 'ok' | 'low' | 'critical' | 'unknown' | 'unsupported' | 'pending' | 'disabled';

export interface UpstreamView {
  id: number;
  name: string;
  type: 'newapi' | 'sub2api';
  siteUrl: string;
  matchDomains: string[];
  topupUrl: string | null;
  /** 实际使用的充值页（new-api 默认 <站点>/console/topup） */
  effectiveTopupUrl: string | null;
  threshold: number;
  emergencyThreshold: number | null;
  intervalMinutes: number;
  rateFactor: number;
  enabled: boolean;
  note: string;
  secrets: Record<SecretField, { set: boolean; masked: string }>;
  status: UpstreamStatus;
  /** 最近一次成功读到的余额；“未知”/不支持时为 null */
  balanceUsd: number | null;
  /** wallet = 钱包余额；key_limit = sub2api Key 限额（不是钱包余额） */
  balanceKind: 'wallet' | 'key_limit' | null;
  mode: string | null;
  alertState: 'normal' | 'low' | 'critical';
  alertLastSentAt: number | null;
  alertLastResult: string | null;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  burnUsdPerDay: number | null;
  exhaustAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function parseDomains(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function cleanDomains(list: string[] | undefined, siteUrl: string): string[] {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    if (!raw.trim()) continue;
    const d = normalizeDomain(raw);
    if (!d) throw new UpstreamValidationError(`匹配域名不合法：${raw.slice(0, 60)}`);
    out.add(d);
  }
  // 未填写时默认匹配站点自身的主机名
  if (out.size === 0) out.add(new URL(siteUrl).hostname.toLowerCase());
  return [...out];
}

export class UpstreamService {
  constructor(
    private readonly deps: {
      config: Pick<AppConfig, 'encryptionKey'>;
      db: Db;
      store: BalanceStore;
      audit: AuditService;
      clock: Clock;
      adapters: ReturnType<typeof createAdapters>;
    },
  ) {}

  private enc(field: SecretField, value: string): string {
    return encrypt(value, this.deps.config.encryptionKey, `upstreams.${field}`);
  }

  private dec(field: SecretField, stored: string | null): string | undefined {
    if (stored === null) return undefined;
    return decrypt(stored, this.deps.config.encryptionKey, `upstreams.${field}`);
  }

  private column(field: SecretField): 'credentialEnc' | 'userIdEnc' | 'accountEnc' | 'passwordEnc' {
    return ({ credential: 'credentialEnc', userId: 'userIdEnc', account: 'accountEnc', password: 'passwordEnc' } as const)[field];
  }

  list(): UpstreamRow[] {
    return this.deps.db.select().from(upstreams).orderBy(asc(upstreams.id)).all();
  }

  find(id: number): UpstreamRow | undefined {
    return this.deps.db.select().from(upstreams).where(eq(upstreams.id, id)).get();
  }

  require(id: number): UpstreamRow {
    const row = this.find(id);
    if (!row) throw new UpstreamNotFoundError();
    return row;
  }

  private checkThresholds(threshold: number, emergency: number | null): void {
    if (emergency !== null && emergency >= threshold) throw new UpstreamValidationError('紧急阈值必须小于提醒阈值');
  }

  private normalizeUrls(siteUrl: string, topupUrl: string | undefined): { siteUrl: string; topupUrl: string | null } {
    try {
      return { siteUrl: normalizeSiteUrl(siteUrl), topupUrl: normalizeOptionalUrl(topupUrl, '充值页地址') };
    } catch (err) {
      if (err instanceof UrlError) throw new UpstreamValidationError(err.message);
      throw err;
    }
  }

  create(input: CreateUpstreamInput, ip?: string): UpstreamRow {
    const { siteUrl, topupUrl } = this.normalizeUrls(input.siteUrl, input.topupUrl);
    const emergency = input.emergencyThreshold ?? null;
    this.checkThresholds(input.threshold, emergency);
    const now = this.deps.clock();
    const row = this.deps.db.transaction((tx) => {
      const inserted = tx
        .insert(upstreams)
        .values({
          name: input.name,
          type: input.type,
          siteUrl,
          matchDomains: JSON.stringify(cleanDomains(input.matchDomains, siteUrl)),
          topupUrl,
          threshold: input.threshold,
          emergencyThreshold: emergency,
          intervalMinutes: input.intervalMinutes ?? 10,
          rateFactor: input.rateFactor ?? 1,
          enabled: input.enabled ?? true,
          note: input.note ?? '',
          credentialEnc: this.enc('credential', input.credential),
          userIdEnc: input.userId ? this.enc('userId', input.userId) : null,
          accountEnc: input.account ? this.enc('account', input.account) : null,
          passwordEnc: input.password ? this.enc('password', input.password) : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.insert(alerts).values({ upstreamId: inserted.id, state: 'normal', updatedAt: now }).run();
      return inserted;
    });
    this.deps.audit.record('upstream.created', { target: `upstream:${row.id}`, ip, detail: row.name });
    return row;
  }

  update(id: number, patch: UpdateUpstreamInput, ip?: string): UpstreamRow {
    const cur = this.require(id);
    const set: Partial<typeof upstreams.$inferInsert> = {};
    const changed: string[] = [];

    if (patch.name !== undefined) set.name = patch.name;
    if (patch.siteUrl !== undefined || patch.topupUrl !== undefined) {
      const { siteUrl, topupUrl } = this.normalizeUrls(patch.siteUrl ?? cur.siteUrl, patch.topupUrl ?? cur.topupUrl ?? undefined);
      set.siteUrl = siteUrl;
      // 换了主机却沿用库里的旧凭证，等于把旧凭证发给新主机：必须同时重新填写
      const credentialGiven = patch.credential !== undefined && patch.credential !== '' && patch.credential !== MASK;
      if (new URL(siteUrl).host !== new URL(cur.siteUrl).host && !credentialGiven) {
        throw new UpstreamValidationError('修改了站点域名，请同时重新填写访问令牌 / API Key');
      }
      if (patch.topupUrl !== undefined) set.topupUrl = topupUrl;
    }
    if (patch.matchDomains !== undefined) set.matchDomains = JSON.stringify(cleanDomains(patch.matchDomains, set.siteUrl ?? cur.siteUrl));
    const threshold = patch.threshold ?? cur.threshold;
    const emergency = patch.emergencyThreshold === undefined ? cur.emergencyThreshold : patch.emergencyThreshold;
    this.checkThresholds(threshold, emergency);
    if (patch.threshold !== undefined) set.threshold = patch.threshold;
    if (patch.emergencyThreshold !== undefined) set.emergencyThreshold = patch.emergencyThreshold;
    if (patch.intervalMinutes !== undefined) set.intervalMinutes = patch.intervalMinutes;
    if (patch.rateFactor !== undefined) set.rateFactor = patch.rateFactor;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.note !== undefined) set.note = patch.note;

    // 敏感字段：留空或回传掩码 = 不修改
    for (const field of SECRET_FIELDS) {
      const v = patch[field];
      if (v === undefined || v === '' || v === MASK) continue;
      set[this.column(field)] = this.enc(field, v);
      changed.push(field);
    }
    changed.unshift(...Object.keys(set));
    if (changed.length === 0) return cur;
    set.updatedAt = this.deps.clock();
    const row = this.deps.db.update(upstreams).set(set).where(eq(upstreams.id, id)).returning().get();
    this.deps.audit.record('upstream.updated', { target: `upstream:${id}`, ip, detail: changed.join(',') });
    return row;
  }

  remove(id: number, ip?: string): void {
    const cur = this.require(id);
    this.deps.db.delete(upstreams).where(eq(upstreams.id, id)).run();
    this.deps.audit.record('upstream.deleted', { target: `upstream:${id}`, ip, detail: cur.name });
  }

  /** 解密凭证供适配器使用。仅在内存中短暂存在。 */
  toAdapterUpstream(row: UpstreamRow): AdapterUpstream {
    return {
      type: row.type,
      siteUrl: row.siteUrl,
      credential: this.dec('credential', row.credentialEnc) ?? '',
      userId: this.dec('userId', row.userIdEnc),
      rateFactor: row.rateFactor,
    };
  }

  /** 显式“复制”：解密后下发，并写 audit_log（不记录明文）。 */
  reveal(id: number, field: SecretField, ip?: string): string | null {
    const row = this.require(id);
    const value = this.dec(field, row[this.column(field)]) ?? null;
    this.deps.audit.record('upstream.secret_copied', { target: `upstream:${id}:${field}`, ip });
    return value;
  }

  /** 测试连接：调用一次适配器，不落库、不写快照、不触发提醒。 */
  async testConnection(input: TestUpstreamInput): Promise<BalanceResult> {
    let siteUrl: string;
    try {
      siteUrl = normalizeSiteUrl(input.siteUrl);
    } catch (err) {
      if (err instanceof UrlError) throw new UpstreamValidationError(err.message);
      throw err;
    }
    const stored = input.id !== undefined ? this.require(input.id) : undefined;
    // 换了站点地址却沿用旧凭证，等于把旧凭证发给新主机：不允许
    if (stored && new URL(stored.siteUrl).host !== new URL(siteUrl).host && (!input.credential || input.credential === MASK)) {
      throw new UpstreamValidationError('修改了站点地址，请重新填写访问令牌/API Key 后再测试');
    }
    const typed = (v: string | undefined) => (v && v !== MASK ? v : undefined);
    const credential = typed(input.credential) ?? (stored ? this.dec('credential', stored.credentialEnc) : undefined);
    if (!credential) throw new UpstreamValidationError('请填写访问令牌 / API Key');
    const userId = input.userId !== undefined ? input.userId || undefined : stored ? this.dec('userId', stored.userIdEnc) : undefined;
    return this.deps.adapters.fetchBalance({
      type: input.type,
      siteUrl,
      credential,
      userId,
      rateFactor: input.rateFactor ?? stored?.rateFactor ?? 1,
    });
  }

  view(row: UpstreamRow): UpstreamView {
    const { store, clock } = this.deps;
    const now = clock();
    const latest = store.latest(row.id);
    const success = store.latestSuccess(row.id);
    const alert = store.getAlert(row.id) ?? { state: 'normal' as const, lastSentAt: null, lastResult: null };

    let status: UpstreamStatus;
    if (!row.enabled) status = 'disabled';
    else if (!latest) status = 'pending';
    else if (latest.mode === 'subscription') status = 'unsupported';
    else if (row.consecutiveFailures >= UNKNOWN_AFTER_FAILURES || !success) status = 'unknown';
    else status = alert.state === 'normal' ? 'ok' : alert.state;

    const showBalance = success && status !== 'unknown' && status !== 'unsupported';
    const burn = showBalance ? estimateBurn(store.points(row.id, now - BURN_WINDOW_MS), now) : { usdPerDay: null, exhaustAt: null };
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      siteUrl: row.siteUrl,
      matchDomains: parseDomains(row.matchDomains),
      topupUrl: row.topupUrl,
      effectiveTopupUrl: row.topupUrl ?? (row.type === 'newapi' ? `${row.siteUrl}/console/topup` : null),
      threshold: row.threshold,
      emergencyThreshold: row.emergencyThreshold,
      intervalMinutes: row.intervalMinutes,
      rateFactor: row.rateFactor,
      enabled: row.enabled,
      note: row.note,
      secrets: {
        credential: { set: row.credentialEnc !== '', masked: MASK },
        userId: { set: row.userIdEnc !== null, masked: row.userIdEnc !== null ? MASK : '' },
        account: { set: row.accountEnc !== null, masked: row.accountEnc !== null ? MASK : '' },
        password: { set: row.passwordEnc !== null, masked: row.passwordEnc !== null ? MASK : '' },
      },
      status,
      balanceUsd: showBalance ? success.balanceUsd : null,
      balanceKind: showBalance ? (success.mode === 'quota_limited' ? 'key_limit' : 'wallet') : null,
      mode: latest?.mode ?? null,
      alertState: alert.state,
      alertLastSentAt: alert.lastSentAt,
      alertLastResult: alert.lastResult,
      lastCheckedAt: row.lastCheckedAt,
      lastSuccessAt: success?.ts ?? null,
      lastError: latest && !latest.ok ? latest.error : null,
      consecutiveFailures: row.consecutiveFailures,
      burnUsdPerDay: burn.usdPerDay,
      exhaustAt: burn.exhaustAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  views(): UpstreamView[] {
    return this.list().map((r) => this.view(r));
  }
}
