import { createAdapters, createOwnSiteClient, type FetchFn } from '../adapters/index.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { Scheduler } from '../jobs/scheduler.js';
import { AdminSettingsService } from './adminSettings.js';
import { AlertService } from './alertService.js';
import { BalanceRefresher } from './balanceRefresher.js';
import { BalanceStore } from './balanceStore.js';
import { ChannelAutomation } from './channelAutomation.js';
import { ChannelService } from './channels.js';
import { OwnSiteService } from './ownSite.js';
import { AuditService } from './audit.js';
import { AuthState } from './authState.js';
import { systemClock, type Clock } from './clock.js';
import { EmailCodeService } from './emailCode.js';
import { LoginService } from './login.js';
import { LoginGuard } from './loginGuard.js';
import { Mailer, defaultTransportFactory, type TransportFactory } from './mailer.js';
import { SettingsStore } from './settings.js';
import { UpstreamService } from './upstreams.js';

export interface ServiceOverrides {
  clock?: Clock;
  /** 注入邮件传输层；测试中用假实现，避免真实发信 */
  transportFactory?: TransportFactory;
  /** 注入外部请求使用的 fetch；测试中用假实现，绝不访问网络 */
  fetch?: FetchFn;
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
  store: BalanceStore;
  upstreams: UpstreamService;
  alerts: AlertService;
  ownSite: OwnSiteService;
  channels: ChannelService;
  refresher: BalanceRefresher;
  /** 只构造、不启动：由 index.ts 在进程入口调用 start()，测试中永远不会启动 */
  scheduler: Scheduler;
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
  const adapterDeps = { fetch: overrides.fetch ?? fetch, clock };
  const adapters = createAdapters(adapterDeps);
  const ownSiteClient = createOwnSiteClient(adapterDeps);
  const store = new BalanceStore(db);
  const upstreams = new UpstreamService({ config, db, store, audit, clock, adapters });
  const alerts = new AlertService({ store, mailer, settings, clock });
  const ownSite = new OwnSiteService({ settings, audit, client: ownSiteClient });
  const channels = new ChannelService({ db, ownSite, client: ownSiteClient, upstreams, audit, clock });
  const automation = new ChannelAutomation({ channels, settings, audit });
  const refresher = new BalanceRefresher({ db, upstreams, store, adapters, alerts, automation, clock });
  const scheduler = new Scheduler({ refresher, store, channels, clock });
  return { config, clock, settings, authState, audit, guard, codes, mailer, login, adminSettings, store, upstreams, alerts, ownSite, channels, refresher, scheduler };
}
