import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppConfig } from '../config.js';
import { apiError } from '../http.js';
import type { Services } from '../services/index.js';
import { createSessionToken, SESSION_TTL_MS, verifySessionToken } from '../services/session.js';

export function sessionCookieName(config: Pick<AppConfig, 'cookieSecure'>): string {
  // __Host- 前缀要求 Secure + Path=/ 且不带 Domain，进一步限制 Cookie 作用域
  return config.cookieSecure ? '__Host-tt_session' : 'tt_session';
}

export function issueSession(c: Parameters<MiddlewareHandler>[0], s: Pick<Services, 'config' | 'authState' | 'clock'>): void {
  const token = createSessionToken(s.config.sessionSecret, s.authState.sessionVersion(), s.clock());
  setCookie(c, sessionCookieName(s.config), token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: s.config.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSession(c: Parameters<MiddlewareHandler>[0], config: Pick<AppConfig, 'cookieSecure'>): void {
  deleteCookie(c, sessionCookieName(config), { path: '/', secure: config.cookieSecure });
}

export function isAuthenticated(c: Parameters<MiddlewareHandler>[0], s: Pick<Services, 'config' | 'authState' | 'clock'>): boolean {
  const token = getCookie(c, sessionCookieName(s.config));
  if (!token) return false;
  const payload = verifySessionToken(s.config.sessionSecret, token, s.clock());
  return payload !== null && payload.ver === s.authState.sessionVersion();
}

export function requireAuth(s: Pick<Services, 'config' | 'authState' | 'clock'>): MiddlewareHandler {
  return async (c, next) => {
    if (!isAuthenticated(c, s)) return apiError(c, 401, 'unauthorized', '未登录或会话已失效');
    await next();
  };
}
