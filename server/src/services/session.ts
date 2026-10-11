import { hmacBase64Url, safeEqual } from './crypto.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  /** 过期时间（毫秒时间戳） */
  exp: number;
  /** 会话版本号，改密码后递增使旧会话失效 */
  ver: number;
}

function sign(secret: string, body: string): string {
  return hmacBase64Url(secret, 'session', body);
}

export function createSessionToken(secret: string, version: number, now: number): string {
  const payload: SessionPayload = { exp: now + SESSION_TTL_MS, ver: version };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** 校验签名与有效期，返回 payload；不检查版本号（由调用方与库中当前版本比较）。 */
export function verifySessionToken(secret: string, token: string, now: number): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(secret, body))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { exp, ver } = parsed as Record<string, unknown>;
    if (typeof exp !== 'number' || typeof ver !== 'number') return null;
    if (exp <= now) return null;
    return { exp, ver };
  } catch {
    return null;
  }
}
