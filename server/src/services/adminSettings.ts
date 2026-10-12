import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AuditService } from './audit.js';
import { includesCode, LOGIN_METHODS, type LoginMethod, type LoginService } from './login.js';
import type { SettingKey, SettingsStore } from './settings.js';

export const MASK = '********';

export const settingsPatchSchema = z.strictObject({
  loginMethod: z.enum(LOGIN_METHODS as [LoginMethod, ...LoginMethod[]]).optional(),
  adminEmail: z.union([z.literal(''), z.email().max(254)]).optional(),
  smtp: z
    .strictObject({
      host: z.string().trim().max(253).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().trim().max(254).optional(),
      /** 留空或不传表示不修改 */
      pass: z.string().max(512).optional(),
      from: z.string().trim().max(254).optional(),
    })
    .optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export class SettingsValidationError extends Error {}

/** 设置页的读写：敏感值永远只返回掩码；修改邮件相关配置会使“已验证”失效。 */
export class AdminSettingsService {
  constructor(
    private readonly deps: {
      config: Pick<AppConfig, 'emergencyPassword'>;
      settings: SettingsStore;
      login: LoginService;
      audit: AuditService;
    },
  ) {}

  view() {
    const { settings, login, config } = this.deps;
    return {
      loginMethod: login.loginMethod(),
      adminEmail: settings.get('admin_email') ?? '',
      smtp: {
        host: settings.get('smtp_host') ?? '',
        port: Number(settings.get('smtp_port') ?? '465'),
        secure: settings.get('smtp_secure') !== 'false',
        user: settings.get('smtp_user') ?? '',
        pass: settings.has('smtp_pass') ? MASK : '',
        passSet: settings.has('smtp_pass'),
        from: settings.get('smtp_from') ?? '',
      },
      smtpVerified: settings.get('smtp_verified') === 'true',
      emergencyPasswordConfigured: config.emergencyPassword !== undefined,
    };
  }

  update(patch: SettingsPatch, ip?: string): { notice?: string } {
    const { settings, audit, login } = this.deps;
    const changed: string[] = [];
    let mailConfigChanged = false;

    const put = (key: SettingKey, value: string, label: string) => {
      if (settings.get(key) !== value) {
        settings.set(key, value);
        changed.push(label);
        return true;
      }
      return false;
    };

    if (patch.adminEmail !== undefined) {
      mailConfigChanged = put('admin_email', patch.adminEmail, 'adminEmail') || mailConfigChanged;
    }
    const smtp = patch.smtp;
    if (smtp) {
      if (smtp.host !== undefined) mailConfigChanged = put('smtp_host', smtp.host, 'smtp.host') || mailConfigChanged;
      if (smtp.port !== undefined) mailConfigChanged = put('smtp_port', String(smtp.port), 'smtp.port') || mailConfigChanged;
      if (smtp.secure !== undefined) mailConfigChanged = put('smtp_secure', String(smtp.secure), 'smtp.secure') || mailConfigChanged;
      if (smtp.user !== undefined) mailConfigChanged = put('smtp_user', smtp.user, 'smtp.user') || mailConfigChanged;
      if (smtp.from !== undefined) mailConfigChanged = put('smtp_from', smtp.from, 'smtp.from') || mailConfigChanged;
      // 密码字段：留空 = 不修改；回传掩码 = 不修改
      if (smtp.pass !== undefined && smtp.pass !== '' && smtp.pass !== MASK) {
        settings.set('smtp_pass', smtp.pass);
        changed.push('smtp.pass');
        mailConfigChanged = true;
      }
    }
    if (mailConfigChanged) settings.set('smtp_verified', 'false');

    let notice: string | undefined;
    const current = login.loginMethod();
    if (patch.loginMethod !== undefined) {
      if (includesCode(patch.loginMethod) && settings.get('smtp_verified') !== 'true') {
        // 邮件配置变更已落库；这里拒绝切换，提示先测试
        if (changed.length > 0) audit.record('settings.updated', { ip, detail: changed.join(',') });
        throw new SettingsValidationError('请先保存 SMTP 与站长邮箱并“发送测试邮件”成功后，再启用验证码登录');
      }
      if (patch.loginMethod !== current) {
        settings.set('login_method', patch.loginMethod);
        changed.push('loginMethod');
      }
    } else if (mailConfigChanged && includesCode(current)) {
      settings.set('login_method', 'password');
      changed.push('loginMethod');
      notice = '邮件配置已变更，登录方式已自动改回“仅密码”，请重新发送测试邮件后再启用验证码登录';
    }

    if (changed.length > 0) audit.record('settings.updated', { ip, detail: changed.join(',') });
    return { notice };
  }

  markSmtpVerified(): void {
    this.deps.settings.set('smtp_verified', 'true');
  }
}
