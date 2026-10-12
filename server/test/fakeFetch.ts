import type { FetchFn } from '../src/adapters/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  /** 请求体（JSON 字符串），无则 undefined */
  body?: string;
  headers: Record<string, string>;
  redirect?: string;
  signal?: AbortSignal;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response> | { throw: Error };

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 假 fetch：记录每次调用（含请求头），由 handler 决定响应。绝不访问网络。 */
export function fakeFetch(handler: Handler): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined, headers, redirect: init?.redirect, signal: init?.signal ?? undefined };
    calls.push(call);
    const out = await handler(call);
    if ('throw' in out && !(out instanceof Response)) throw out.throw;
    return out as Response;
  }) as FetchFn;
  return { fetch: fetchFn, calls };
}
