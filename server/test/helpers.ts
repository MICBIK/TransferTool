import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/client.js';
import { buildServices, type Services } from '../src/services/index.js';
import type { MailMessage, MailTransport, SmtpConfig } from '../src/services/mailer.js';

export interface Harness {
  s: Services;
  app: ReturnType<typeof createApp>;
  sent: MailMessage[];
  smtpConfigs: SmtpConfig[];
  failSend: { value: boolean };
  clock: { now: number };
  db: ReturnType<typeof openDatabase>['db'];
}

export const ADMIN_PASSWORD = 'correct horse battery';
export const EMERGENCY_PASSWORD = 'emergency-pass-123';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    dataDir: '/nonexistent',
    encryptionKey: randomBytes(32),
    sessionSecret: 'test-session-secret-0123456789abcdef-xyz',
    adminPassword: ADMIN_PASSWORD,
    emergencyPassword: undefined,
    cookieSecure: false,
    trustProxy: true,
    webDist: '/nonexistent',
    ...overrides,
  };
}

/** 内存数据库 + 假时钟 + 假 SMTP 传输（只记录，绝不真正发信）。 */
export async function makeHarness(configOverrides: Partial<AppConfig> = {}): Promise<Harness> {
  const { db } = openDatabase(':memory:');
  const clock = { now: 1_700_000_000_000 };
  const sent: MailMessage[] = [];
  const smtpConfigs: SmtpConfig[] = [];
  const failSend = { value: false };
  const transport: MailTransport = {
    async sendMail(message) {
      if (failSend.value) throw Object.assign(new Error('boom secret-detail'), { code: 'ECONNREFUSED' });
      sent.push(message);
    },
  };
  const config = testConfig(configOverrides);
  const s = buildServices(config, db, {
    clock: () => clock.now,
    hashIterations: 1000,
    transportFactory: (smtp) => {
      smtpConfigs.push(smtp);
      return transport;
    },
  });
  await s.authState.initialize(config.adminPassword);
  return { s, app: createApp(s), sent, smtpConfigs, failSend, clock, db };
}

export function post(h: Harness, path: string, body: unknown, opts: { cookie?: string; ip?: string } = {}) {
  return request(h, 'POST', path, body, opts);
}

export function request(h: Harness, method: string, path: string, body?: unknown, opts: { cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '203.0.113.7' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  return h.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** 从 Set-Cookie 提取 "name=value"，可直接作为后续请求的 Cookie 头。 */
export function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

export async function login(h: Harness, password = ADMIN_PASSWORD, ip?: string): Promise<string> {
  const res = await post(h, '/api/auth/login', { password }, { ip });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return cookieFrom(res);
}

export const SMTP_BODY = {
  adminEmail: 'owner@example.com',
  smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailer', pass: 'smtp-secret-pw', from: 'TransferTool <noreply@example.com>' },
};

/** 配置 SMTP 并通过测试邮件验证，然后切换登录方式。 */
export async function enableCodeLogin(h: Harness, cookie: string, method: 'email_code' | 'both' = 'both'): Promise<void> {
  expectOk(await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie }));
  expectOk(await post(h, '/api/settings/smtp/test', {}, { cookie }));
  expectOk(await request(h, 'PUT', '/api/settings', { loginMethod: method }, { cookie }));
  h.sent.length = 0;
}

function expectOk(res: Response) {
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
}

export function lastCode(h: Harness): string {
  const m = h.sent.at(-1)?.text.match(/\b(\d{6})\b/);
  if (!m?.[1]) throw new Error('no code in last mail');
  return m[1];
}

/** 测试里读取 JSON 响应用，结构由断言自行校验。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function json(res: Response): Promise<any> {
  return res.json();
}
