import { Hono, type Context } from 'hono';
import { apiError, clientIp, parseBody } from '../http.js';
import { assignBodySchema, batchStatusBodySchema, ChannelError, statusBodySchema } from '../services/channels.js';
import type { Services } from '../services/index.js';

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** 需登录的本站渠道接口。渠道 key 从不请求、不缓存、不下发。 */
export function channelRoutes(s: Services): Hono {
  const app = new Hono();
  const ip = (c: Context) => clientIp(c, s.config.trustProxy);
  const fail = (c: Context, err: unknown) => {
    if (err instanceof ChannelError) {
      if (err.code === 'not_found') return apiError(c, 404, err.code, err.message);
      if (err.code === 'not_configured' || err.code === 'invalid') return apiError(c, 400, err.code, err.message);
      return apiError(c, 502, err.code, err.message);
    }
    throw err;
  };
  const listing = () => ({
    configured: s.channels.configured,
    syncedAt: s.channels.lastSyncAt ?? s.channels.rows().reduce<number | null>((m, r) => (m === null || r.syncedAt > m ? r.syncedAt : m), null),
    lastError: s.channels.lastError,
    channels: s.channels.views(),
  });

  app.get('/', (c) => c.json(listing()));

  /** 每个上游的启用/总数（总览卡片用）；upstreamId 为 null 的是未归类渠道 */
  app.get('/summary', (c) => c.json({ configured: s.channels.configured, summary: s.channels.summary() }));

  /** 未归类渠道按主域名分组，作为“添加上游”的建议 */
  app.get('/upstream-suggestions', (c) => c.json({ configured: s.channels.configured, suggestions: s.channels.upstreamSuggestions() }));

  app.post('/sync', async (c) => {
    const result = await s.channels.sync();
    return c.json({ result, ...listing() });
  });

  app.post('/status', async (c) => {
    const body = await parseBody(c, batchStatusBodySchema);
    if (!body.ok) return body.response;
    try {
      const result = await s.channels.setStatus(body.data.ids, body.data.status, { source: 'manual', ip: ip(c) });
      return c.json({ result, ...listing() });
    } catch (err) {
      return fail(c, err);
    }
  });

  /** 一键停用/启用某上游的全部渠道 */
  app.post('/upstream/:upstreamId/status', async (c) => {
    const upstreamId = parseId(c.req.param('upstreamId'));
    if (upstreamId === null) return apiError(c, 404, 'not_found', '上游不存在');
    const body = await parseBody(c, statusBodySchema);
    if (!body.ok) return body.response;
    try {
      const result = await s.channels.setUpstreamStatus(upstreamId, body.data.status, ip(c));
      return c.json({ result, ...listing() });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/:id/status', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return apiError(c, 404, 'not_found', '渠道不存在');
    const body = await parseBody(c, statusBodySchema);
    if (!body.ok) return body.response;
    try {
      const result = await s.channels.setStatus([id], body.data.status, { source: 'manual', ip: ip(c) });
      if (result.failed.length > 0) return apiError(c, 502, 'site_error', result.failed[0]!.error);
      return c.json({ result, ...listing() });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/:id/test', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return apiError(c, 404, 'not_found', '渠道不存在');
    try {
      const result = await s.channels.test(id);
      return c.json({ result, ...listing() });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.put('/:id/upstream', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return apiError(c, 404, 'not_found', '渠道不存在');
    const body = await parseBody(c, assignBodySchema);
    if (!body.ok) return body.response;
    try {
      const channel = await s.channels.assignUpstream(id, body.data.upstreamId, ip(c));
      return c.json({ channel });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
