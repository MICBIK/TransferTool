import { jsonRes, type RecordedCall } from './fakeFetch.js';

export interface FakeChannel {
  id: number;
  name: string;
  base_url: string;
  group: string;
  status: number;
  type?: number;
  priority?: number;
  weight?: number;
  response_time?: number;
  tag?: string;
  /** 真实站点的列表接口不会返回 key；这里放一个用来验证“绝不落库”的哨兵 */
  key?: string;
}

export interface FakeLog {
  id: number;
  created_at: number;
  /** 2 = 消费，5 = 错误 */
  type: number;
  channel?: number;
  channel_id?: number;
  use_time?: number;
  content?: string;
  model_name?: string;
  quota?: number;
  /** 真实日志里有的敏感字段：必须不被保存 */
  token_name?: string;
  ip?: string;
}

export const OWN = 'https://own.example.com';
export const OWN_TOKEN = 'own-token-SECRET-1234';

/**
 * 假的本站 new-api：分页列表、单个/批量启停、测试。state 可随意改动来模拟站长在本站的操作。
 * 记录每个请求，便于断言“只发了 {status}”之类。
 */
export function fakeOwnSite(opts: { pageSize?: number; batch?: boolean; zeroBased?: boolean; logPageSize?: number; logArray?: boolean } = {}) {
  const state = {
    channels: [] as FakeChannel[],
    /** 为 true 时，所有写请求返回 500 */
    failWrites: false,
    /** 出现在这些 id 上的单个启停失败（HTTP 200 success:false） */
    failIds: new Set<number>(),
    /** 批量接口返回 500，但先停掉前 N 个（模拟部分生效） */
    batchPartial: null as number | null,
    testResult: { success: true, message: '', time: 0.42 } as { success: boolean; message: string; time: number },
    calls: [] as RecordedCall[],
    logs: [] as FakeLog[],
    /** 为 true 时日志接口返回 403 ACCESS_TOKEN_SCOPE_DENIED */
    logScopeDenied: false,
    /** 为 true 时日志接口返回 HTTP 200 + success:false */
    logBusinessError: false,
  };
  const pageSize = opts.pageSize ?? 100;
  const ok = (data?: unknown) => jsonRes({ success: true, message: '', ...(data === undefined ? {} : { data }) });

  function handle(c: RecordedCall): Response {
    state.calls.push(c);
    const url = new URL(c.url);
    const path = url.pathname;
    if (c.headers.authorization !== `Bearer ${OWN_TOKEN}`) {
      return jsonRes({ success: false, message: 'unauthorized' }, 401);
    }
    const body = c.body ? (JSON.parse(c.body) as Record<string, unknown>) : {};
    if (c.method === 'GET' && path === '/api/channel/') {
      const p = Number(url.searchParams.get('p') ?? '0');
      const size = Number(url.searchParams.get('page_size') ?? '100');
      const per = Math.min(size, pageSize);
      const start = opts.zeroBased ? p * per : Math.max(0, p - 1) * per;
      return ok({ items: state.channels.slice(start, start + per), total: state.channels.length });
    }
    if (c.method === 'GET' && path === '/api/log/') {
      if (state.logScopeDenied) return jsonRes({ success: false, message: 'missing scope log:read', code: 'ACCESS_TOKEN_SCOPE_DENIED' }, 403);
      if (state.logBusinessError) return jsonRes({ success: false, message: '无权查看日志' });
      const q = url.searchParams;
      const type = Number(q.get('type') ?? '0');
      const start = Number(q.get('start_timestamp') ?? '0');
      const end = Number(q.get('end_timestamp') ?? '9999999999');
      const p = Number(q.get('p') ?? '1');
      const per = Math.min(Number(q.get('page_size') ?? '100'), opts.logPageSize ?? 100);
      const rows = state.logs.filter((l) => (type === 0 || l.type === type) && l.created_at >= start && l.created_at <= end).sort((a, b) => b.id - a.id);
      const items = rows.slice((Math.max(1, p) - 1) * per, Math.max(1, p) * per);
      if (opts.logArray) return jsonRes({ success: true, data: items });
      return jsonRes({ success: true, message: '', data: { items, total: rows.length, page: p, page_size: per } });
    }
    if (c.method === 'POST' && path === '/api/channel/status/batch') {
      if (opts.batch === false) return new Response('404 page not found', { status: 404 });
      if (state.batchPartial !== null) {
        for (const id of (body.ids as number[]).slice(0, state.batchPartial)) state.channels.find((ch) => ch.id === id)!.status = body.status as number;
        return jsonRes({ success: false, message: 'boom' }, 500);
      }
      if (state.failWrites) return jsonRes({ success: false, message: 'boom' }, 500);
      for (const id of body.ids as number[]) state.channels.find((ch) => ch.id === id)!.status = body.status as number;
      return ok();
    }
    const single = path.match(/^\/api\/channel\/(\d+)\/status$/);
    if (c.method === 'POST' && single) {
      if (state.failWrites) return jsonRes({ success: false, message: 'boom' }, 500);
      const id = Number(single[1]);
      if (state.failIds.has(id)) return jsonRes({ success: false, message: '渠道不存在' });
      const ch = state.channels.find((x) => x.id === id);
      if (!ch) return jsonRes({ success: false, message: '渠道不存在' });
      ch.status = body.status as number;
      return ok();
    }
    const test = path.match(/^\/api\/channel\/test\/(\d+)$/);
    if (c.method === 'GET' && test) return jsonRes(state.testResult);
    return new Response('404 page not found', { status: 404 });
  }
  return { state, handle };
}
