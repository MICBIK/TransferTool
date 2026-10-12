import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { apiError, clientIp, parseBody } from '../http.js';
import type { Services } from '../services/index.js';
import {
  createUpstreamSchema,
  SECRET_FIELDS,
  testUpstreamSchema,
  UpstreamNotFoundError,
  UpstreamValidationError,
  updateUpstreamSchema,
  type SecretField,
} from '../services/upstreams.js';

const DAY_MS = 24 * 3600 * 1000;

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** 需登录的上游接口。敏感字段只返回掩码；唯一例外是显式的“复制”接口（写 audit_log）。 */
export function upstreamRoutes(s: Services): Hono {
  const app = new Hono();
  const notFound = (c: Context) => apiError(c, 404, 'not_found', '上游不存在');
  const invalid = (c: Context, err: unknown) => {
    if (err instanceof UpstreamValidationError) return apiError(c, 400, 'upstream_invalid', err.message);
    if (err instanceof UpstreamNotFoundError) return notFound(c);
    throw err;
  };

  app.get('/', (c) => c.json({ upstreams: s.upstreams.views() }));

  app.post('/', async (c) => {
    const body = await parseBody(c, createUpstreamSchema);
    if (!body.ok) return body.response;
    try {
      const row = s.upstreams.create(body.data, clientIp(c, s.config.trustProxy));
      await s.channels.reclassify();
      // 保存后立即刷新一次，让总览马上有数据；失败不影响保存
      if (row.enabled) await s.refresher.run({ ids: [row.id], force: true });
      return c.json({ upstream: s.upstreams.view(s.upstreams.require(row.id)) }, 201);
    } catch (err) {
      return invalid(c, err);
    }
  });

  app.post('/test', async (c) => {
    const body = await parseBody(c, testUpstreamSchema);
    if (!body.ok) return body.response;
    try {
      const r = await s.upstreams.testConnection(body.data);
      return c.json({ ok: r.ok, balanceUsd: r.balanceUsd ?? null, mode: r.mode, kind: r.kind ?? null, unsupported: r.unsupported === true, error: r.error ?? null });
    } catch (err) {
      return invalid(c, err);
    }
  });

  app.post('/refresh', async (c) => {
    const summary = await s.refresher.run({ force: true });
    return c.json({ summary, upstreams: s.upstreams.views() });
  });

  app.get('/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const row = id === null ? undefined : s.upstreams.find(id);
    return row ? c.json({ upstream: s.upstreams.view(row) }) : notFound(c);
  });

  app.put('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null || !s.upstreams.find(id)) return notFound(c);
    const body = await parseBody(c, updateUpstreamSchema);
    if (!body.ok) return body.response;
    try {
      const row = s.upstreams.update(id, body.data, clientIp(c, s.config.trustProxy));
      if (body.data.matchDomains !== undefined) await s.channels.reclassify();
      return c.json({ upstream: s.upstreams.view(row) });
    } catch (err) {
      return invalid(c, err);
    }
  });

  app.delete('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null || !s.upstreams.find(id)) return notFound(c);
    s.upstreams.remove(id, clientIp(c, s.config.trustProxy));
    await s.channels.reclassify(); // 外键已把它的渠道置为未归类，这里按剩余上游重新归类
    return c.json({ ok: true });
  });

  app.post('/:id/refresh', async (c) => {
    const id = parseId(c.req.param('id'));
    const row = id === null ? undefined : s.upstreams.find(id);
    if (id === null || !row) return notFound(c);
    if (!row.enabled) return apiError(c, 400, 'upstream_disabled', '该上游已停用，请先启用再刷新');
    const summary = await s.refresher.run({ ids: [id], force: true });
    const fresh = s.upstreams.find(id);
    return fresh ? c.json({ summary, upstream: s.upstreams.view(fresh) }) : notFound(c);
  });

  app.get('/:id/history', (c) => {
    const id = parseId(c.req.param('id'));
    const row = id === null ? undefined : s.upstreams.find(id);
    if (id === null || !row) return notFound(c);
    const days = z.coerce.number().int().min(1).max(90).catch(7).parse(c.req.query('days'));
    const points = s.store.points(id, s.clock() - days * DAY_MS);
    return c.json({ days, threshold: row.threshold, emergencyThreshold: row.emergencyThreshold, points });
  });

  /** 显式复制：解密下发明文，并写入 audit_log（不记录明文）。 */
  app.post('/:id/secrets/:field/copy', (c) => {
    const id = parseId(c.req.param('id'));
    const field = c.req.param('field') as SecretField;
    if (id === null || !s.upstreams.find(id) || !SECRET_FIELDS.includes(field)) return notFound(c);
    let value: string | null;
    try {
      value = s.upstreams.reveal(id, field, clientIp(c, s.config.trustProxy));
    } catch {
      return apiError(c, 500, 'decrypt_failed', '无法解密该字段（ENCRYPTION_KEY 是否更换过？）');
    }
    if (value === null) return apiError(c, 404, 'not_set', '该字段尚未设置');
    return c.json({ value });
  });

  return app;
}
