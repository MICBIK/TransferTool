import { Hono } from 'hono';
import { DASHBOARD_DAYS, type DashboardDays } from '../services/dashboard.js';
import type { Services } from '../services/index.js';

/** 需登录：总览看板的时间序列（余额、消耗、请求量） */
export function dashboardRoutes(s: Services): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const raw = Number(c.req.query('days'));
    const days: DashboardDays = (DASHBOARD_DAYS as readonly number[]).includes(raw) ? (raw as DashboardDays) : 7;
    return c.json(s.dashboard.series(days));
  });
  return app;
}
