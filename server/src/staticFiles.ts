import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { getMimeType } from 'hono/utils/mime';

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? await readFile(path) : null;
  } catch {
    return null;
  }
}

/** 同进程提供前端静态文件；未命中且不是带扩展名的资源路径时回退到 index.html（SPA）。 */
export function serveSpa(root: string): MiddlewareHandler {
  const base = resolve(root);
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (path.startsWith('/api/') || path === '/api') return next();

    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return c.text('Bad Request', 400);
    }
    const target = resolve(join(base, rel));
    if (target !== base && !target.startsWith(base + sep)) return c.text('Not Found', 404);

    const file = rel === '/' ? null : await readIfFile(target);
    if (file) {
      const immutable = rel.startsWith('/assets/');
      c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      c.header('Content-Type', getMimeType(target) ?? 'application/octet-stream');
      return c.body(new Uint8Array(file));
    }
    if (extname(rel) !== '') return c.text('Not Found', 404);

    const index = await readIfFile(join(base, 'index.html'));
    if (!index) return c.text('前端尚未构建', 404);
    c.header('Cache-Control', 'no-cache');
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(new Uint8Array(index));
  };
}
