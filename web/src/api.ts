export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return data as T;

  const err = (data as { error?: { code?: string; message?: string; retryAfterSeconds?: number } } | null)?.error;
  // 登录接口自身的 401（密码错误）不应触发“会话过期”跳转
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `请求失败（${res.status}）`, err?.retryAfterSeconds);
}
