import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { Clock } from './clock.js';
import { decrypt, encrypt } from './crypto.js';

/**
 * 设置项注册表。sensitive=true 的值落库前加密。
 * 后续阶段（上游/本站令牌等）在此追加键即可。
 */
export const SETTING_DEFS = {
  login_method: { sensitive: false },
  admin_email: { sensitive: false },
  smtp_host: { sensitive: false },
  smtp_port: { sensitive: false },
  smtp_secure: { sensitive: false },
  smtp_user: { sensitive: false },
  smtp_pass: { sensitive: true },
  smtp_from: { sensitive: false },
  /** 最近一次 SMTP/站长邮箱配置是否已通过“发送测试邮件”验证 */
  smtp_verified: { sensitive: false },
  /** 持续低于阈值时，余额提醒邮件的最短重复间隔（小时），默认 6 */
  alert_repeat_hours: { sensitive: false },
  /** 余额归零自动停该上游全部渠道，默认关闭 */
  auto_disable_at_zero: { sensitive: false },
  /** 本站 new-api 连接：地址、访问令牌（加密）、用户 ID（加密，可选） */
  own_site_url: { sensitive: false },
  own_site_token: { sensitive: true },
  own_site_user_id: { sensitive: true },
  /** 渠道健康：成功率 ≥ ok 为正常、≥ degraded 为降级（百分数），默认 95 / 80 */
  health_ok_rate: { sensitive: false },
  health_degraded_rate: { sensitive: false },
  /** 本站日志增量拉取的游标状态（JSON）：下次起点、边界秒内已入库的日志 id、分段大小 */
  log_ingest_state: { sensitive: false },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly clock: Clock,
  ) {}

  get(name: SettingKey): string | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, name)).get();
    if (!row) return undefined;
    if (SETTING_DEFS[name].sensitive) return decrypt(row.value, this.key, name);
    return row.value;
  }

  set(name: SettingKey, value: string): void {
    const sensitive = SETTING_DEFS[name].sensitive;
    const stored = sensitive ? encrypt(value, this.key, name) : value;
    const now = this.clock();
    this.db
      .insert(settings)
      .values({ key: name, value: stored, encrypted: sensitive, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: stored, encrypted: sensitive, updatedAt: now } })
      .run();
  }

  delete(name: SettingKey): void {
    this.db.delete(settings).where(eq(settings.key, name)).run();
  }

  has(name: SettingKey): boolean {
    return this.db.select({ key: settings.key }).from(settings).where(eq(settings.key, name)).get() !== undefined;
  }
}
