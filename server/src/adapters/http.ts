import type { FetchFn } from './types.js';

export const USER_AGENT = 'TransferTool/0.2 (+balance-monitor)';
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 1_000_000;

/** 面向用户的请求失败原因；消息中不含 URL 查询串、请求头或凭证。 */
export class UpstreamRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'redirect' | 'too_large' | 'aborted',
  ) {
    super(message);
  }
}

export interface JsonResponse {
  status: number;
  /** 解析后的 JSON；响应体不是 JSON 时为 undefined */
  body: unknown;
}

export interface JsonRequest {
  method?: 'GET' | 'POST' | 'PUT';
  /** 非 undefined 时作为 JSON 请求体发送 */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 通过注入的 fetch 发 GET 并解析 JSON。
 *  - 10 秒超时（可被外部 signal 提前中止）
 *  - redirect: 'manual'：绝不跟随重定向，避免把凭证带到别的主机
 *  - 响应体大小上限
 */
export async function getJson(fetchFn: FetchFn, url: string, req: JsonRequest = {}): Promise<JsonResponse> {
  return requestJson(fetchFn, url, req);
}

/** 同 getJson，但可带方法与 JSON 请求体（本站渠道管理使用）。超时、不跟随重定向、大小上限相同。 */
export async function requestJson(fetchFn: FetchFn, url: string, req: JsonRequest = {}): Promise<JsonResponse> {
  const signals = [AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (req.signal) signals.push(req.signal);
  const signal = AbortSignal.any(signals);

  let res: Response;
  let text: string;
  try {
    res = await fetchFn(url, {
      method: req.method ?? 'GET',
      redirect: 'manual',
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...req.headers,
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new UpstreamRequestError(`上游返回了重定向（HTTP ${res.status}），为避免把凭证发往其他地址，已拒绝跟随。请把站点地址改成最终地址（例如改用 https）`, 'redirect');
    }
    text = await res.text();
  } catch (err) {
    if (err instanceof UpstreamRequestError) throw err;
    if (req.signal?.aborted) throw new UpstreamRequestError('请求已取消', 'aborted');
    if (signal.aborted) throw new UpstreamRequestError('请求上游超时（10 秒）', 'timeout');
    throw new UpstreamRequestError(`无法连接上游（${errorCode(err)}）`, 'network');
  }
  if (text.length > MAX_BODY_CHARS) throw new UpstreamRequestError('上游响应过大', 'too_large');

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function errorCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '网络错误';
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** 宽松取数：接受 number 或数字字符串。 */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 把上游返回的文字裁剪成可展示的短消息，并抹掉凭证。 */
export function safeMessage(text: unknown, secrets: string[], max = 200): string {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
