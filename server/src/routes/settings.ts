import { Hono } from 'hono';
import { z } from 'zod';
import { apiError, clientIp, parseBody } from '../http.js';
import { issueSession } from '../middleware/auth.js';
import { SettingsValidationError, settingsPatchSchema } from '../services/adminSettings.js';
import type { Services } from '../services/index.js';
import { OwnSiteValidationError, ownSitePatchSchema, ownSiteTestSchema } from '../services/ownSite.js';
import { MailerError } from '../services/mailer.js';

const passwordChangeBody = z.strictObject({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(8).max(256),
});

/** 需登录的设置接口。 */
export function settingsRoutes(s: Services): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(s.adminSettings.view()));

  app.put('/', async (c) => {
    const body = await parseBody(c, settingsPatchSchema);
    if (!body.ok) return body.response;
    try {
      const { notice } = s.adminSettings.update(body.data, clientIp(c, s.config.trustProxy));
      return c.json({ ...s.adminSettings.view(), notice });
    } catch (err) {
      if (err instanceof SettingsValidationError) return apiError(c, 400, 'settings_invalid', err.message);
      throw err;
    }
  });

  /** 本站 new-api 连接（令牌只返回掩码） */
  app.get('/own-site', (c) => c.json(s.ownSite.view()));

  app.put('/own-site', async (c) => {
    const body = await parseBody(c, ownSitePatchSchema);
    if (!body.ok) return body.response;
    try {
      s.ownSite.update(body.data, clientIp(c, s.config.trustProxy));
    } catch (err) {
      if (err instanceof OwnSiteValidationError) return apiError(c, 400, 'settings_invalid', err.message);
      throw err;
    }
    // 保存后立刻同步一次，让渠道页马上有数据；失败不影响保存
    const sync = s.ownSite.view().configured ? await s.channels.sync() : null;
    return c.json({ ...s.ownSite.view(), sync });
  });

  app.post('/own-site/test', async (c) => {
    const body = await parseBody(c, ownSiteTestSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(await s.ownSite.test(body.data));
    } catch (err) {
      if (err instanceof OwnSiteValidationError) return apiError(c, 400, 'settings_invalid', err.message);
      throw err;
    }
  });

  app.post('/password', async (c) => {
    const body = await parseBody(c, passwordChangeBody);
    if (!body.ok) return body.response;
    const ip = clientIp(c, s.config.trustProxy);

    const status = s.guard.check(ip);
    if (status.locked) {
      c.header('Retry-After', String(status.retryAfterSeconds));
      return apiError(c, 429, 'locked', '失败次数过多，已被临时锁定，请稍后再试', { retryAfterSeconds: status.retryAfterSeconds });
    }
    if (!(await s.authState.verify(body.data.currentPassword))) {
      s.guard.recordFailure(ip);
      s.audit.record('password.change_failed', { ip });
      return apiError(c, 400, 'wrong_password', '当前密码错误');
    }
    await s.authState.changePassword(body.data.newPassword);
    s.audit.record('password.changed', { ip });
    // 旧会话（包括当前这个）因版本号变化全部失效；给当前浏览器换发新会话，避免被踢出
    issueSession(c, s);
    return c.json({ ok: true });
  });

  app.post('/smtp/test', async (c) => {
    const ip = clientIp(c, s.config.trustProxy);
    try {
      await s.mailer.sendTest();
    } catch (err) {
      s.audit.record('smtp.test_failed', { ip });
      const message = err instanceof MailerError ? err.message : '邮件发送失败';
      return apiError(c, 400, 'smtp_test_failed', message);
    }
    s.adminSettings.markSmtpVerified();
    s.audit.record('smtp.test_ok', { ip });
    return c.json({ ok: true });
  });

  return app;
}
