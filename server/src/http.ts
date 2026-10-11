import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // 取最右一项：Nginx/Caddy 追加的是它们看到的真实对端地址，左侧部分可被客户端伪造
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').at(-1)?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function apiError(c: Context, status: 400 | 401 | 403 | 404 | 429 | 500 | 502, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { code, message, ...extra } }, status);
}

/** 解析并校验 JSON 请求体；失败时返回 null（调用方应已拿到 400 响应）。 */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: apiError(c, 400, 'bad_request', '请求体不是有效的 JSON') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: apiError(c, 400, 'validation_failed', '参数不合法') };
  }
  return { ok: true, data: parsed.data };
}
