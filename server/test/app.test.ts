import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, loginCodes, settings } from '../src/db/schema.js';
import { decrypt } from '../src/services/crypto.js';
import {
  ADMIN_PASSWORD,
  EMERGENCY_PASSWORD,
  SMTP_BODY,
  cookieFrom,
  enableCodeLogin,
  lastCode,
  login,
  json,
  makeHarness,
  post,
  request,
} from './helpers.js';

describe('访问控制', () => {
  it('/healthz 公开，其余 /api/* 未登录一律 401', async () => {
    const h = await makeHarness();
    expect((await request(h, 'GET', '/healthz')).status).toBe(200);
    for (const [method, path] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['POST', '/api/settings/password'],
      ['POST', '/api/settings/smtp/test'],
      ['GET', '/api/does-not-exist'],
      ['GET', '/api/upstreams'],
    ] as const) {
      expect((await request(h, method, path, method === 'GET' ? undefined : {})).status, `${method} ${path}`).toBe(401);
    }
  });

  it('登录接口公开；登录后未知 /api 路径为 404 JSON', async () => {
    const h = await makeHarness();
    const session = await request(h, 'GET', '/api/auth/session');
    expect(await json(session)).toMatchObject({ authenticated: false, methods: { password: true, emailCode: false } });
    const cookie = await login(h);
    const res = await request(h, 'GET', '/api/nope', undefined, { cookie });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('伪造、篡改、过期的会话 Cookie 无效', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie })).status).toBe(200);

    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: 'tt_session=garbage' })).status).toBe(401);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: tampered })).status).toBe(401);

    h.clock.now += 7 * 24 * 3600 * 1000 + 1;
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie })).status).toBe(401);
  });

  it('响应带安全头且 API 不缓存', async () => {
    const h = await makeHarness();
    const res = await request(h, 'GET', '/api/settings');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('密码登录与会话 Cookie', () => {
  it('Cookie 为 HttpOnly + SameSite=Strict + 7 天；Secure 受 COOKIE_SECURE 控制', async () => {
    const plain = await makeHarness({ cookieSecure: false });
    const raw = (await post(plain, '/api/auth/login', { password: ADMIN_PASSWORD })).headers.get('set-cookie') ?? '';
    expect(raw).toMatch(/^tt_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Max-Age=604800/);
    expect(raw).not.toMatch(/Secure/i);

    const secure = await makeHarness({ cookieSecure: true });
    const rawSecure = (await post(secure, '/api/auth/login', { password: ADMIN_PASSWORD })).headers.get('set-cookie') ?? '';
    expect(rawSecure).toMatch(/^__Host-tt_session=/);
    expect(rawSecure).toMatch(/Secure/i);
    expect(rawSecure).toMatch(/HttpOnly/i);
  });

  it('错误密码 401，不设置 Cookie', async () => {
    const h = await makeHarness();
    const res = await post(h, '/api/auth/login', { password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('请求体不合法返回 400', async () => {
    const h = await makeHarness();
    expect((await post(h, '/api/auth/login', { pass: 'x' })).status).toBe(400);
    expect((await post(h, '/api/auth/login', { password: '' })).status).toBe(400);
  });

  it('同一 IP 连续 5 次失败后锁 15 分钟（即使之后密码正确）', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 4; i++) expect((await post(h, '/api/auth/login', { password: 'bad' })).status).toBe(401);
    const fifth = await post(h, '/api/auth/login', { password: 'bad' });
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('retry-after')).toBe('900');

    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD })).status).toBe(429);
    // 其他 IP 不受影响
    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD }, { ip: '198.51.100.9' })).status).toBe(200);

    h.clock.now += 15 * 60 * 1000;
    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD })).status).toBe(200);
  });

  it('日志与审计不含密码', async () => {
    const h = await makeHarness();
    await post(h, '/api/auth/login', { password: 'super-secret-attempt' });
    await login(h);
    expect(JSON.stringify(h.db.select().from(auditLog).all())).not.toContain('super-secret-attempt');
    expect(JSON.stringify(h.db.select().from(auditLog).all())).not.toContain(ADMIN_PASSWORD);
  });

  it('退出登录清除 Cookie', async () => {
    const h = await makeHarness();
    const res = await post(h, '/api/auth/logout', {});
    expect(res.headers.get('set-cookie')).toMatch(/tt_session=;/);
  });
});

describe('修改密码与会话失效', () => {
  it('改密码后旧会话全部失效，新密码可登录、旧密码不可', async () => {
    const h = await makeHarness();
    const a = await login(h);
    const b = await login(h);

    const wrong = await post(h, '/api/settings/password', { currentPassword: 'nope', newPassword: 'new-password-1' }, { cookie: a });
    expect(wrong.status).toBe(400);
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: b })).status).toBe(200);

    const short = await post(h, '/api/settings/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'short' }, { cookie: a });
    expect(short.status).toBe(400);

    const ok = await post(h, '/api/settings/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'new-password-1' }, { cookie: a });
    expect(ok.status).toBe(200);
    const fresh = cookieFrom(ok);

    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: a })).status).toBe(401);
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: b })).status).toBe(401);
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie: fresh })).status).toBe(200);

    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD })).status).toBe(401);
    expect((await post(h, '/api/auth/login', { password: 'new-password-1' })).status).toBe(200);
  });

  it('会话版本号随改密码递增', async () => {
    const h = await makeHarness();
    const before = h.s.authState.sessionVersion();
    await h.s.authState.changePassword('another-password');
    expect(h.s.authState.sessionVersion()).toBe(before + 1);
  });

  it('当前密码输错也计入 IP 失败次数', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    for (let i = 0; i < 4; i++) {
      expect((await post(h, '/api/settings/password', { currentPassword: 'x', newPassword: 'new-password-1' }, { cookie })).status).toBe(400);
    }
    const res = await post(h, '/api/settings/password', { currentPassword: 'x', newPassword: 'new-password-1' }, { cookie });
    expect(res.status).toBe(400);
    expect((await post(h, '/api/settings/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'new-password-1' }, { cookie })).status).toBe(429);
  });
});

describe('紧急密码', () => {
  it('配置后在仅验证码模式下仍可用密码登录；管理员密码此时不可用', async () => {
    const h = await makeHarness({ emergencyPassword: EMERGENCY_PASSWORD });
    const cookie = await login(h);
    await enableCodeLogin(h, cookie, 'email_code');

    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD })).status).toBe(401);
    expect((await post(h, '/api/auth/login', { password: EMERGENCY_PASSWORD })).status).toBe(200);
    expect(h.db.select().from(auditLog).where(eq(auditLog.action, 'login.success.emergency')).all()).toHaveLength(1);
  });

  it('未配置紧急密码时，仅验证码模式下密码登录被拒绝', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await enableCodeLogin(h, cookie, 'email_code');
    expect((await post(h, '/api/auth/login', { password: ADMIN_PASSWORD })).status).toBe(401);
    const s = await json(await request(h, 'GET', '/api/auth/session'));
    expect(s.methods).toEqual({ password: false, emailCode: true });
  });
});

describe('设置：敏感信息加密与掩码', () => {
  it('SMTP 密码落库为密文，接口只返回掩码', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    const res = await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('smtp-secret-pw');
    expect(text).toContain('********');

    const get = await json(await request(h, 'GET', '/api/settings', undefined, { cookie }));
    expect(get.smtp).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, user: 'mailer', passSet: true, pass: '********' });
    expect(get.adminEmail).toBe('owner@example.com');

    const row = h.db.select().from(settings).where(eq(settings.key, 'smtp_pass')).get();
    expect(row?.encrypted).toBe(true);
    expect(row?.value).toMatch(/^enc:v1:/);
    expect(row?.value).not.toContain('smtp-secret-pw');
    expect(decrypt(row?.value ?? '', h.s.config.encryptionKey, 'smtp_pass')).toBe('smtp-secret-pw');
    // 其余普通项不加密
    expect(h.db.select().from(settings).where(eq(settings.key, 'smtp_host')).get()?.encrypted).toBe(false);
  });

  it('密码留空或回传掩码表示不修改', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    await request(h, 'PUT', '/api/settings', { smtp: { pass: '' } }, { cookie });
    await request(h, 'PUT', '/api/settings', { smtp: { pass: '********' } }, { cookie });
    expect(h.s.settings.get('smtp_pass')).toBe('smtp-secret-pw');
    await request(h, 'PUT', '/api/settings', { smtp: { pass: 'changed-pw' } }, { cookie });
    expect(h.s.settings.get('smtp_pass')).toBe('changed-pw');
  });

  it('密文被换到别的键或被改动时读取失败', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    const row = h.db.select().from(settings).where(eq(settings.key, 'smtp_pass')).get();
    h.db.update(settings).set({ value: row?.value.slice(0, -4) + 'AAAA' }).where(eq(settings.key, 'smtp_pass')).run();
    expect(() => h.s.settings.get('smtp_pass')).toThrow();
  });

  it('不接受未知字段与非法取值', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    expect((await request(h, 'PUT', '/api/settings', { foo: 1 }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { loginMethod: 'sms' }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { adminEmail: 'not-an-email' }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { smtp: { port: 70000 } }, { cookie })).status).toBe(400);
  });

  it('审计日志记录设置变更但不含值', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    const detail = h.db.select().from(auditLog).where(eq(auditLog.action, 'settings.updated')).get()?.detail ?? '';
    expect(detail).toContain('smtp.pass');
    expect(detail).not.toContain('smtp-secret-pw');
    expect(detail).not.toContain('owner@example.com');
  });
});

describe('登录方式与 SMTP', () => {
  it('SMTP 未验证前不能切换到含验证码的方式', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    expect((await request(h, 'PUT', '/api/settings', { loginMethod: 'both' }, { cookie })).status).toBe(400);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    expect((await request(h, 'PUT', '/api/settings', { loginMethod: 'both' }, { cookie })).status).toBe(400);
    expect((await post(h, '/api/settings/smtp/test', {}, { cookie })).status).toBe(200);
    expect((await request(h, 'PUT', '/api/settings', { loginMethod: 'both' }, { cookie })).status).toBe(200);
  });

  it('测试邮件发给站长邮箱，使用解密后的 SMTP 配置；失败时不暴露底层信息', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    expect((await post(h, '/api/settings/smtp/test', {}, { cookie })).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe('owner@example.com');
    expect(h.smtpConfigs[0]).toMatchObject({ host: 'smtp.example.com', pass: 'smtp-secret-pw' });

    h.failSend.value = true;
    const bad = await post(h, '/api/settings/smtp/test', {}, { cookie });
    expect(bad.status).toBe(400);
    const text = JSON.stringify(await bad.json());
    expect(text).toContain('ECONNREFUSED');
    expect(text).not.toContain('secret-detail');
  });

  it('测试邮件连不上时给出具体原因，并检测哪些端口能连通', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    const fail = async (error: Error) => {
      h.failSend.value = true;
      h.failSend.error = error;
      h.probed.length = 0;
      const res = await post(h, '/api/settings/smtp/test', {}, { cookie });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { message: string } }).error.message;
    };
    // nodemailer 把底层的 ECONNREFUSED 包装成 ESOCKET，原码放在 originalCode
    const refused = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:465 secret-detail'), { code: 'ESOCKET', originalCode: 'ECONNREFUSED' });
    let msg = await fail(refused);
    expect(msg).toContain('连接被拒绝');
    expect(msg).toContain('ESOCKET / ECONNREFUSED');
    expect(msg).toContain('全部不通');
    expect(msg).not.toContain('secret-detail');
    expect(h.probed).toEqual([465, 587]);

    h.openPorts.add(587);
    msg = await fail(refused);
    expect(msg).toContain('建议改用 587 端口（SSL 关闭）');

    h.openPorts.add(465);
    msg = await fail(Object.assign(new Error('wrong version number'), { code: 'ESOCKET' }));
    expect(msg).toContain('SSL/TLS 握手失败');
    expect(msg).toContain('问题更可能在 SSL 开关');

    // 认证失败是服务器明确的回复，不需要探测端口
    msg = await fail(Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH', responseCode: 535 }));
    expect(msg).toContain('用户名或密码被拒绝');
    expect(h.probed).toEqual([]);
  });

  it('填了 SMTP 主机却没有发件人时拒绝保存', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    const res = await request(h, 'PUT', '/api/settings', { ...SMTP_BODY, smtp: { ...SMTP_BODY.smtp, from: '' } }, { cookie });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('发件人');
    expect(h.s.settings.get('smtp_host')).toBeUndefined();
    // 已保存完整配置后，单独清空发件人同样被拒绝；只改其他字段不受影响
    await request(h, 'PUT', '/api/settings', SMTP_BODY, { cookie });
    expect((await request(h, 'PUT', '/api/settings', { smtp: { from: '  ' } }, { cookie })).status).toBe(400);
    expect((await request(h, 'PUT', '/api/settings', { smtp: { port: 587 } }, { cookie })).status).toBe(200);
    // 主机和发件人一起清空（停用邮件）是允许的
    expect((await request(h, 'PUT', '/api/settings', { smtp: { host: '', from: '' } }, { cookie })).status).toBe(200);
  });

  it('未配置 SMTP 时测试邮件返回 400', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    expect((await post(h, '/api/settings/smtp/test', {}, { cookie })).status).toBe(400);
  });

  it('修改 SMTP/站长邮箱后“已验证”失效，含验证码的登录方式自动退回仅密码', async () => {
    const h = await makeHarness();
    const cookie = await login(h);
    await enableCodeLogin(h, cookie, 'both');
    const res = await request(h, 'PUT', '/api/settings', { adminEmail: 'new-owner@example.com' }, { cookie });
    const body = await json(res);
    expect(body.loginMethod).toBe('password');
    expect(body.smtpVerified).toBe(false);
    expect(body.notice).toBeTruthy();
  });
});

describe('邮件验证码登录', () => {
  async function codeHarness(method: 'email_code' | 'both' = 'both') {
    const h = await makeHarness();
    const cookie = await login(h);
    await enableCodeLogin(h, cookie, method);
    return h;
  }

  it('未启用验证码方式时拒绝发送，且不发邮件', async () => {
    const h = await makeHarness();
    const res = await post(h, '/api/auth/code/request', {});
    expect(res.status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it('请求验证码 → 邮件发给站长邮箱 → 校验通过获得会话', async () => {
    const h = await codeHarness();
    const req = await post(h, '/api/auth/code/request', {});
    expect(req.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(lastCode(h)).toMatch(/^\d{6}$/);

    const res = await post(h, '/api/auth/code/verify', { code: lastCode(h) });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect((await request(h, 'GET', '/api/settings', undefined, { cookie })).status).toBe(200);
  });

  it('收件人永远是设置里的站长邮箱，请求里的邮箱被忽略', async () => {
    const h = await codeHarness();
    for (const body of [{ email: 'attacker@evil.test' }, { to: 'attacker@evil.test' }]) {
      h.clock.now += 61_000;
      const res = await post(h, '/api/auth/code/request', body);
      expect(res.status).toBe(200);
    }
    expect(h.sent.length).toBe(2);
    for (const m of h.sent) expect(m.to).toBe('owner@example.com');
  });

  it('验证码一次性', async () => {
    const h = await codeHarness();
    await post(h, '/api/auth/code/request', {});
    const code = lastCode(h);
    expect((await post(h, '/api/auth/code/verify', { code })).status).toBe(200);
    expect((await post(h, '/api/auth/code/verify', { code })).status).toBe(401);
  });

  it('5 分钟过期', async () => {
    const h = await codeHarness();
    await post(h, '/api/auth/code/request', {});
    const code = lastCode(h);
    h.clock.now += 5 * 60 * 1000;
    expect((await post(h, '/api/auth/code/verify', { code })).status).toBe(401);
  });

  it('60 秒内重复请求 429，每小时最多 5 封', async () => {
    const h = await codeHarness();
    expect((await post(h, '/api/auth/code/request', {})).status).toBe(200);
    h.clock.now += 30_000;
    const soon = await post(h, '/api/auth/code/request', {});
    expect(soon.status).toBe(429);
    expect((await json(soon)).error.code).toBe('too_soon');
    expect(h.sent).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      h.clock.now += 61_000;
      expect((await post(h, '/api/auth/code/request', {})).status).toBe(200);
    }
    h.clock.now += 61_000;
    const limited = await post(h, '/api/auth/code/request', {});
    expect(limited.status).toBe(429);
    expect((await json(limited)).error.code).toBe('hourly_limit');
    expect(h.sent).toHaveLength(5);
  });

  it('验证码错误计入 IP 锁定（5 次后即使验证码正确也被拒）', async () => {
    const h = await codeHarness();
    await post(h, '/api/auth/code/request', {});
    const code = lastCode(h);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) expect((await post(h, '/api/auth/code/verify', { code: wrong })).status).toBe(401);
    expect((await post(h, '/api/auth/code/verify', { code: wrong })).status).toBe(429);
    expect((await post(h, '/api/auth/code/verify', { code })).status).toBe(429);
  });

  it('密码失败与验证码失败共用同一计数', async () => {
    const h = await codeHarness();
    for (let i = 0; i < 3; i++) await post(h, '/api/auth/login', { password: 'bad' });
    await post(h, '/api/auth/code/request', {});
    const code = lastCode(h);
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await post(h, '/api/auth/code/verify', { code: wrong })).status).toBe(401);
    expect((await post(h, '/api/auth/code/verify', { code: wrong })).status).toBe(429);
  });

  it('被锁定的 IP 不能再请求发送验证码', async () => {
    const h = await codeHarness();
    for (let i = 0; i < 5; i++) await post(h, '/api/auth/login', { password: 'bad' });
    expect((await post(h, '/api/auth/code/request', {})).status).toBe(429);
    expect(h.sent).toHaveLength(0);
  });

  it('邮件发送失败返回 502 且验证码作废', async () => {
    const h = await codeHarness();
    h.failSend.value = true;
    const res = await post(h, '/api/auth/code/request', {});
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret-detail');
    expect(h.db.select().from(loginCodes).all().every((r) => r.used)).toBe(true);
  });

  it('库里只有哈希，没有明文验证码', async () => {
    const h = await codeHarness();
    await post(h, '/api/auth/code/request', {});
    const code = lastCode(h);
    expect(JSON.stringify(h.db.select().from(loginCodes).all())).not.toContain(code);
    expect(JSON.stringify(h.db.select().from(auditLog).all())).not.toContain(code);
  });

  it('仅密码模式下验证码校验一律失败', async () => {
    const h = await makeHarness();
    expect((await post(h, '/api/auth/code/verify', { code: '123456' })).status).toBe(401);
  });
});
