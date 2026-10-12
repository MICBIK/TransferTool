import nodemailer from 'nodemailer';
import type { SettingsStore } from './settings.js';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** 传输层抽象，测试中注入假实现，绝不真正发信。 */
export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export type TransportFactory = (smtp: SmtpConfig) => MailTransport;

export const defaultTransportFactory: TransportFactory = (smtp) =>
  nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

export class MailerError extends Error {}

/** 从设置读取 SMTP 配置并发信。收件人由调用方固定为站长邮箱。 */
export class Mailer {
  constructor(
    private readonly settings: SettingsStore,
    private readonly factory: TransportFactory = defaultTransportFactory,
  ) {}

  smtpConfig(): SmtpConfig | null {
    const host = this.settings.get('smtp_host');
    const from = this.settings.get('smtp_from');
    if (!host || !from) return null;
    return {
      host,
      port: Number(this.settings.get('smtp_port') ?? '465'),
      secure: this.settings.get('smtp_secure') !== 'false',
      user: this.settings.get('smtp_user') || undefined,
      pass: this.settings.get('smtp_pass') || undefined,
      from,
    };
  }

  adminEmail(): string | undefined {
    return this.settings.get('admin_email') || undefined;
  }

  async sendToAdmin(subject: string, text: string): Promise<void> {
    const smtp = this.smtpConfig();
    const to = this.adminEmail();
    if (!smtp || !to) throw new MailerError('SMTP 或站长邮箱尚未配置');
    try {
      await this.factory(smtp).sendMail({ from: smtp.from, to, subject, text });
    } catch (err) {
      // 只保留简短原因，避免把含凭证的底层信息写进日志/响应
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN';
      throw new MailerError(`邮件发送失败（${code}）`);
    }
  }

  sendLoginCode(code: string): Promise<void> {
    return this.sendToAdmin('TransferTool 登录验证码', `您的登录验证码是：${code}\n\n5 分钟内有效，且只能使用一次。如果不是您本人操作，请忽略本邮件。`);
  }

  sendTest(): Promise<void> {
    return this.sendToAdmin('TransferTool 测试邮件', '这是一封来自 TransferTool 的测试邮件。收到说明 SMTP 配置正确。');
  }
}
