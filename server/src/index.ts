import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { dbFileFor, openDatabase } from './db/client.js';
import { buildServices } from './services/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = openDatabase(dbFileFor(config.dataDir));
  const services = buildServices(config, handle.db);

  if (await services.authState.initialize(config.adminPassword)) {
    services.audit.record('auth.initialized', { detail: '由 ADMIN_PASSWORD 初始化' });
    console.log('[init] 已使用 ADMIN_PASSWORD 初始化管理员密码，请登录后尽快在“设置”页修改');
  }

  const app = createApp(services);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[server] TransferTool 已启动，监听端口 ${info.port}`);
  });

  // 进程内调度：启动时立即刷新一次，之后每分钟检查到期的上游
  services.scheduler.start();

  const shutdown = () => {
    void services.scheduler.stop().finally(() => {
      server.close(() => {
        handle.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // ConfigError 的消息已确保不含变量值
  console.error(err instanceof ConfigError || err instanceof Error ? `[fatal] ${err.message}` : '[fatal] 启动失败');
  process.exit(1);
});
