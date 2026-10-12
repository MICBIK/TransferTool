import type { AppConfig } from '../config.js';
import type { AuditService } from './audit.js';
import type { AuthState } from './authState.js';
import { safeEqual } from './crypto.js';
import type { EmailCodeService } from './emailCode.js';
import type { LoginGuard } from './loginGuard.js';
import type { Mailer } from './mailer.js';
import { MailerError } from './mailer.js';
import type { SettingsStore } from './settings.js';

export type LoginMethod = 'password' | 'email_code' | 'both';
export const LOGIN_METHODS: readonly LoginMethod[] = ['password', 'email_code', 'both'];

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'invalid' };

export type CodeRequestOutcome =
  | { ok: true; resendAfterSeconds: number }
  | { ok: false; reason: 'locked' | 'too_soon' | 'hourly_limit'; retryAfterSeconds: number }
  | { ok: false; reason: 'unavailable' | 'send_failed' };

export function includesCode(method: LoginMethod): boolean {
  return method === 'email_code' || method === 'both';
}

/** 登录流程编排：密码 / 紧急密码 / 邮件验证码，统一接入 IP 失败计数与审计。 */
export class LoginService {
  constructor(
    private readonly deps: {
      config: Pick<AppConfig, 'emergencyPassword'>;
      settings: SettingsStore;
      authState: AuthState;
      guard: LoginGuard;
      codes: EmailCodeService;
      mailer: Mailer;
      audit: AuditService;
    },
  ) {}

  loginMethod(): LoginMethod {
    const raw = this.deps.settings.get('login_method');
    return LOGIN_METHODS.find((m) => m === raw) ?? 'password';
  }

  /** 验证码登录是否可用：方式包含验证码，且 SMTP 与站长邮箱已配置并通过测试。 */
  codeLoginAvailable(): boolean {
    const { settings, mailer } = this.deps;
    return (
      includesCode(this.loginMethod()) &&
      settings.get('smtp_verified') === 'true' &&
      mailer.smtpConfig() !== null &&
      mailer.adminEmail() !== undefined
    );
  }

  /** 登录页展示用：哪些方式可用（紧急密码也算密码方式可用，但不对外暴露其存在）。 */
  availableMethods(): { password: boolean; emailCode: boolean } {
    const method = this.loginMethod();
    return {
      password: method !== 'email_code' || this.deps.config.emergencyPassword !== undefined,
      emailCode: this.codeLoginAvailable(),
    };
  }

  async loginWithPassword(ip: string, password: string): Promise<LoginOutcome> {
    const { guard, audit, authState, config } = this.deps;
    const status = guard.check(ip);
    if (status.locked) return { ok: false, reason: 'locked', retryAfterSeconds: status.retryAfterSeconds };

    const passwordAllowed = this.loginMethod() !== 'email_code';
    const normal = passwordAllowed ? await authState.verify(password) : false;
    const emergency = config.emergencyPassword !== undefined && safeEqual(password, config.emergencyPassword);

    if (normal || emergency) {
      guard.recordSuccess(ip);
      audit.record(emergency && !normal ? 'login.success.emergency' : 'login.success', { ip, detail: 'password' });
      return { ok: true };
    }
    return this.failure(ip, 'password');
  }

  async requestCode(ip: string): Promise<CodeRequestOutcome> {
    const { guard, codes, mailer, audit } = this.deps;
    const status = guard.check(ip);
    if (status.locked) return { ok: false, reason: 'locked', retryAfterSeconds: status.retryAfterSeconds };
    if (!this.codeLoginAvailable()) return { ok: false, reason: 'unavailable' };

    const issued = codes.issue();
    if (!issued.ok) return { ok: false, reason: issued.reason, retryAfterSeconds: issued.retryAfterSeconds };

    try {
      // 收件人只来自设置中的站长邮箱，永远不取自请求
      await mailer.sendLoginCode(issued.code);
    } catch (err) {
      codes.revoke(issued.id);
      audit.record('code.send_failed', { ip, detail: err instanceof MailerError ? err.message : '未知错误' });
      return { ok: false, reason: 'send_failed' };
    }
    audit.record('code.sent', { ip });
    return { ok: true, resendAfterSeconds: 60 };
  }

  verifyCode(ip: string, code: string): LoginOutcome {
    const { guard, codes, audit } = this.deps;
    const status = guard.check(ip);
    if (status.locked) return { ok: false, reason: 'locked', retryAfterSeconds: status.retryAfterSeconds };
    if (!this.codeLoginAvailable()) return this.failure(ip, 'email_code');

    if (codes.verify(code)) {
      guard.recordSuccess(ip);
      audit.record('login.success', { ip, detail: 'email_code' });
      return { ok: true };
    }
    return this.failure(ip, 'email_code');
  }

  private failure(ip: string, via: string): LoginOutcome {
    const { guard, audit } = this.deps;
    const after = guard.recordFailure(ip);
    audit.record('login.failure', { ip, detail: via });
    if (after.locked) {
      audit.record('login.locked', { ip });
      return { ok: false, reason: 'locked', retryAfterSeconds: after.retryAfterSeconds };
    }
    return { ok: false, reason: 'invalid' };
  }
}
