import { Hono } from 'hono';
import { z } from 'zod';
import { apiError, clientIp, parseBody } from '../http.js';
import { clearSession, isAuthenticated, issueSession } from '../middleware/auth.js';
import type { Services } from '../services/index.js';

const passwordBody = z.strictObject({ password: z.string().min(1).max(512) });
const codeBody = z.strictObject({ code: z.string().min(1).max(16) });

/** 登录相关接口，无需会话。注意：验证码接口不接受邮箱参数，收件人固定为站长邮箱。 */
export function authRoutes(s: Services): Hono {
  const app = new Hono();
  const ipOf = (c: Parameters<typeof clientIp>[0]) => clientIp(c, s.config.trustProxy);

  app.get('/session', (c) => {
    return c.json({ authenticated: isAuthenticated(c, s), methods: s.login.availableMethods() });
  });

  app.post('/login', async (c) => {
    const body = await parseBody(c, passwordBody);
    if (!body.ok) return body.response;
    const result = await s.login.loginWithPassword(ipOf(c), body.data.password);
    if (result.ok) {
      issueSession(c, s);
      return c.json({ ok: true });
    }
    if (result.reason === 'locked') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return apiError(c, 429, 'locked', '失败次数过多，已被临时锁定，请稍后再试', { retryAfterSeconds: result.retryAfterSeconds });
    }
    return apiError(c, 401, 'invalid_credentials', '密码错误');
  });

  app.post('/code/request', async (c) => {
    const result = await s.login.requestCode(ipOf(c));
    if (result.ok) return c.json({ ok: true, resendAfterSeconds: result.resendAfterSeconds });
    switch (result.reason) {
      case 'unavailable':
        return apiError(c, 400, 'code_login_unavailable', '未启用验证码登录');
      case 'send_failed':
        return apiError(c, 502, 'send_failed', '验证码邮件发送失败，请检查 SMTP 配置');
      case 'too_soon':
        c.header('Retry-After', String(result.retryAfterSeconds));
        return apiError(c, 429, 'too_soon', '发送过于频繁，请 60 秒后再试', { retryAfterSeconds: result.retryAfterSeconds });
      case 'hourly_limit':
        c.header('Retry-After', String(result.retryAfterSeconds));
        return apiError(c, 429, 'hourly_limit', '本小时发送次数已达上限，请稍后再试', { retryAfterSeconds: result.retryAfterSeconds });
      case 'locked':
        c.header('Retry-After', String(result.retryAfterSeconds));
        return apiError(c, 429, 'locked', '失败次数过多，已被临时锁定，请稍后再试', { retryAfterSeconds: result.retryAfterSeconds });
    }
  });

  app.post('/code/verify', async (c) => {
    const body = await parseBody(c, codeBody);
    if (!body.ok) return body.response;
    const result = s.login.verifyCode(ipOf(c), body.data.code.trim());
    if (result.ok) {
      issueSession(c, s);
      return c.json({ ok: true });
    }
    if (result.reason === 'locked') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return apiError(c, 429, 'locked', '失败次数过多，已被临时锁定，请稍后再试', { retryAfterSeconds: result.retryAfterSeconds });
    }
    return apiError(c, 401, 'invalid_code', '验证码错误或已过期');
  });

  app.post('/logout', (c) => {
    clearSession(c, s.config);
    return c.json({ ok: true });
  });

  return app;
}
