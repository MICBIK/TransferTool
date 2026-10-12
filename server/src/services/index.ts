import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { AdminSettingsService } from './adminSettings.js';
import { AuditService } from './audit.js';
import { AuthState } from './authState.js';
import { systemClock, type Clock } from './clock.js';
import { EmailCodeService } from './emailCode.js';
import { LoginService } from './login.js';
import { LoginGuard } from './loginGuard.js';
import { Mailer, defaultTransportFactory, type TransportFactory } from './mailer.js';
import { SettingsStore } from './settings.js';

export interface ServiceOverrides {
  clock?: Clock;
  /** 注入邮件传输层；测试中用假实现，避免真实发信 */
  transportFactory?: TransportFactory;
  /** 仅测试使用：降低 PBKDF2 迭代次数以加速 */
  hashIterations?: number;
}

export interface Services {
  config: AppConfig;
  clock: Clock;
  settings: SettingsStore;
  authState: AuthState;
  audit: AuditService;
  guard: LoginGuard;
  codes: EmailCodeService;
  mailer: Mailer;
  login: LoginService;
  adminSettings: AdminSettingsService;
}

/** 组装依赖。后续阶段的服务（上游、渠道、调度器等）在此追加。 */
export function buildServices(config: AppConfig, db: Db, overrides: ServiceOverrides = {}): Services {
  const clock = overrides.clock ?? systemClock;
  const settings = new SettingsStore(db, config.encryptionKey, clock);
  const authState = new AuthState(db, clock, overrides.hashIterations);
  const audit = new AuditService(db, clock);
  const guard = new LoginGuard(db, clock);
  const codes = new EmailCodeService(db, config.sessionSecret, clock);
  const mailer = new Mailer(settings, overrides.transportFactory ?? defaultTransportFactory);
  const login = new LoginService({ config, settings, authState, guard, codes, mailer, audit });
  const adminSettings = new AdminSettingsService({ config, settings, login, audit });
  return { config, clock, settings, authState, audit, guard, codes, mailer, login, adminSettings };
}
