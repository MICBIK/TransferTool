import net from 'node:net';
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

/** 检测本机能否连上 host:port（只建 TCP 连接，不发任何数据）。 */
export type PortProbe = (host: string, port: number) => Promise<boolean>;

export const defaultPortProbe: PortProbe = (host, port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 5_000 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });

interface ErrInfo {
  code?: string;
  originalCode?: string;
  responseCode?: number;
  message: string;
}

function errInfo(err: unknown): ErrInfo {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    code: str(e.code),
    originalCode: str(e.originalCode),
    responseCode: typeof e.responseCode === 'number' ? e.responseCode : undefined,
    message: err instanceof Error ? err.message : String(err),
  };
}

const CONNECT_CODES = new Set(['ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'ETLS', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EPROTO', 'ENOTFOUND', 'EAI_AGAIN']);

/** 是否属于“连不上服务器”这一类（而不是认证、发件人被拒等服务器明确回复的错误） */
function isConnectError(info: ErrInfo): boolean {
  return (info.code !== undefined && CONNECT_CODES.has(info.code)) || (info.originalCode !== undefined && CONNECT_CODES.has(info.originalCode));
}

/**
 * 把 nodemailer 的错误翻译成站长能处理的原因。只用错误码和固定文案，
 * 不回显底层错误信息，避免把服务器回复或凭证片段带进日志/响应。
 */
export function describeMailError(err: unknown): string {
  const info = errInfo(err);
  const codes = [info.code, info.originalCode].filter((c): c is string => !!c && c !== 'Error');
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  let reason: string;
  if (has('EAUTH') || info.responseCode === 535) reason = 'SMTP 用户名或密码被拒绝，请检查用户名和密码（Resend 的密码是 API Key）';
  else if (has('EENVELOPE') || (info.responseCode !== undefined && info.responseCode >= 550 && info.responseCode <= 554))
    reason = '发件人或收件人被服务器拒绝，请确认发件人域名已在服务商处验证';
  else if (has('EDNS', 'ENOTFOUND', 'EAI_AGAIN')) reason = '无法解析 SMTP 主机名，请检查主机拼写，或服务器 / Docker 容器的 DNS 设置';
  else if (has('ETIMEDOUT')) reason = '连接超时，服务器的出站 SMTP 端口很可能被防火墙或云厂商封锁';
  else if (has('ECONNREFUSED')) reason = '连接被拒绝，端口不对，或出站端口被防火墙拦截';
  else if (has('ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL')) reason = '网络不可达，服务器（或 Docker 容器）连不到该地址，常见于容器没有 IPv6 网络';
  else if (has('ETLS', 'EPROTO') || /ssl|tls|wrong version|certificate/i.test(info.message))
    reason = 'SSL/TLS 握手失败，请确认 SSL 开关与端口对应：465 / 2465 开启，587 / 2587 关闭';
  else if (has('ECONNRESET', 'ECONNECTION', 'ESOCKET')) reason = '连接被中途断开，多为 SSL 开关与端口不匹配，或出站 SMTP 连接被拦截';
  else reason = '原因未知，请检查 SMTP 配置';
  return `邮件发送失败：${reason}${codes.length ? `（${codes.join(' / ')}）` : ''}`;
}

/** 连不上时，探测常用端口，给出“哪些端口能通”的线索 */
function probePorts(smtp: SmtpConfig): number[] {
  const ports = [smtp.port, 465, 587];
  if (/(^|\.)resend\.com$/i.test(smtp.host)) ports.push(2465, 2587);
  return [...new Set(ports)];
}

/** 从设置读取 SMTP 配置并发信。收件人由调用方固定为站长邮箱。 */
export class Mailer {
  constructor(
    private readonly settings: SettingsStore,
    private readonly factory: TransportFactory = defaultTransportFactory,
    private readonly probe: PortProbe = defaultPortProbe,
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

  async sendToAdmin(subject: string, text: string, opts: { diagnose?: boolean } = {}): Promise<void> {
    const smtp = this.smtpConfig();
    const to = this.adminEmail();
    if (!smtp || !to) throw new MailerError('SMTP 或站长邮箱尚未配置');
    try {
      await this.factory(smtp).sendMail({ from: smtp.from, to, subject, text });
    } catch (err) {
      let message = describeMailError(err);
      if (opts.diagnose && isConnectError(errInfo(err))) message += await this.diagnose(smtp);
      throw new MailerError(message);
    }
  }

  private async diagnose(smtp: SmtpConfig): Promise<string> {
    const ports = probePorts(smtp);
    const ok = await Promise.all(ports.map((p) => this.probe(smtp.host, p).catch(() => false)));
    const open = ports.filter((_, i) => ok[i]);
    const closed = ports.filter((_, i) => !ok[i]);
    if (open.length === 0)
      return `。本服务器连 ${smtp.host} 的 ${closed.join(' / ')} 端口全部不通，说明出站 SMTP 被封锁或网络不通，需要在云厂商安全组 / 防火墙放行，或换用其他发信方式`;
    if (open.includes(smtp.port)) return `。本服务器能连上 ${smtp.port} 端口，问题更可能在 SSL 开关：465 / 2465 开启，587 / 2587 关闭`;
    return `。本服务器连不上 ${closed.join(' / ')} 端口，但 ${open.join(' / ')} 端口可以连通，建议改用 ${open[0]} 端口（${open[0] === 587 || open[0] === 2587 ? 'SSL 关闭' : 'SSL 开启'}）`;
  }

  sendLoginCode(code: string): Promise<void> {
    return this.sendToAdmin('TransferTool 登录验证码', `您的登录验证码是：${code}\n\n5 分钟内有效，且只能使用一次。如果不是您本人操作，请忽略本邮件。`);
  }

  sendTest(): Promise<void> {
    return this.sendToAdmin('TransferTool 测试邮件', '这是一封来自 TransferTool 的测试邮件。收到说明 SMTP 配置正确。', { diagnose: true });
  }
}
