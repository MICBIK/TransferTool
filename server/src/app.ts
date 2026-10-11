import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { apiError } from './http.js';
import { requireAuth } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { channelRoutes } from './routes/channels.js';
import { healthRoutes } from './routes/health.js';
import { settingsRoutes } from './routes/settings.js';
import { upstreamRoutes } from './routes/upstreams.js';
import type { Services } from './services/index.js';
import { serveSpa } from './staticFiles.js';

/**
 * 组装 Hono 应用。路由约定：
 *  - /healthz            无需登录（容器健康检查）
 *  - /api/auth/*         登录相关，无需会话
 *  - 其余 /api/*         一律需要会话；后续阶段的路由在“受保护区”追加
 *  - 其他 GET            前端静态文件 / SPA 回退
 */
export function createApp(s: Services): Hono {
  const app = new Hono();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Naive UI 运行时会注入 <style>
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => apiError(c, 400, 'too_large', '请求体过大') }));
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.route('/api/auth', authRoutes(s));

  // ---- 受保护区：以下 /api/* 均需登录 ----
  app.use('/api/*', requireAuth(s));
  app.route('/api/settings', settingsRoutes(s));
  app.route('/api/upstreams', upstreamRoutes(s));
  app.route('/api/channels', channelRoutes(s));
  app.route('/api/health', healthRoutes(s));

  app.all('/api/*', (c) => apiError(c, 404, 'not_found', '接口不存在'));

  app.use('*', serveSpa(s.config.webDist));
  app.notFound((c) => c.text('Not Found', 404));
  app.onError((err, c) => {
    // 只记录错误名称，避免把请求内容或凭证带进日志
    console.error(`[error] ${c.req.method} ${c.req.path} ${err.name}`);
    return apiError(c, 500, 'internal', '服务器内部错误');
  });

  return app;
}
