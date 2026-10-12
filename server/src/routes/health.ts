import { Hono } from 'hono';
import { z } from 'zod';
import { apiError } from '../http.js';
import type { Services } from '../services/index.js';

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

const bucketMinutes = z.coerce.number().int().refine((n) => [5, 15, 30, 60].includes(n)).catch(30);

/** 需登录的渠道健康接口（只读聚合数据；原始日志从不落库）。 */
export function healthRoutes(s: Services): Hono {
  const app = new Hono();

  /** 全部渠道的健康、各上游汇总、日志拉取状态与“请确认错误日志已开启”提示 */
  app.get('/', (c) => c.json(s.health.overview()));

  /** 立即拉取一次日志；本站报错（缺权限、不可达等）返回 502 */
  app.post('/ingest', async (c) => {
    if (!s.logIngestor.configured) return apiError(c, 400, 'not_configured', '尚未配置本站地址与访问令牌，请先到“设置”页填写');
    const result = await s.logIngestor.run();
    if (!result.ok) return apiError(c, 502, 'site_error', result.error ?? '拉取日志失败');
    return c.json({ result, ...s.health.overview() });
  });

  /** 单个渠道：近 24 小时成功率趋势与错误 Top 5 */
  app.get('/channels/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const detail = id === null ? null : s.health.channelDetail(id, { bucketMinutes: bucketMinutes.parse(c.req.query('bucketMinutes')) });
    return detail ? c.json({ channel: detail }) : apiError(c, 404, 'not_found', '渠道不存在');
  });

  /** 某上游：汇总状态，加上它名下每个渠道的趋势与错误 Top 5 */
  app.get('/upstreams/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const detail = id === null ? null : s.health.upstreamDetail(id, bucketMinutes.parse(c.req.query('bucketMinutes')));
    return detail ? c.json(detail) : apiError(c, 404, 'not_found', '上游不存在');
  });

  return app;
}
