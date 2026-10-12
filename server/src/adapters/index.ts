import { createNewApiAdapter } from './newapi.js';
import { createSub2ApiAdapter } from './sub2api.js';
import { asRecord, getJson } from './http.js';
import type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, FetchContext, UpstreamType } from './types.js';

export type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, BalanceKind, FetchContext, FetchFn, UpstreamType } from './types.js';
export { createOwnSiteClient, LOG_SCOPE_MESSAGE, OLD_VERSION_MESSAGE, type LogQuery, type LogType, type SiteLog, type SiteErrorKind, type ChannelStatus, type ChannelTestResult, type OwnSiteClient, type OwnSiteConn, type SiteChannel, type SiteResult, type StatusManyResult } from './ownsite.js';
export { normalizeDomain, normalizeOptionalUrl, normalizeSiteUrl, UrlError } from './url.js';

/** 按上游类型分发。外部请求全部经注入的 fetch，便于测试。 */
export function createAdapters(deps: AdapterDeps): {
  fetchBalance(upstream: AdapterUpstream, ctx?: FetchContext): Promise<BalanceResult>;
  detectType(siteUrl: string, ctx?: FetchContext): Promise<UpstreamType>;
} {
  const adapters: Record<AdapterUpstream['type'], Adapter> = {
    newapi: createNewApiAdapter(deps),
    sub2api: createSub2ApiAdapter(deps),
  };
  return {
    async fetchBalance(upstream, ctx) {
      try {
        return await adapters[upstream.type].fetchBalance(upstream, ctx);
      } catch {
        // 适配器内部的意外错误不外泄细节
        return { ok: false, mode: 'unknown', error: '读取余额时发生内部错误' };
      }
    },
    /**
     * 猜测站点类型（只用于自动创建的上游，站长仍需确认）：
     * new-api 的公开接口 /api/status 返回 {success:true,data:{...}}；能连上却不是这个形状的按 sub2api 处理；
     * 连不上时无从判断，默认 new-api。
     */
    async detectType(siteUrl, ctx) {
      try {
        const res = await getJson(deps.fetch, `${siteUrl}/api/status`, { timeoutMs: deps.timeoutMs, signal: ctx?.signal });
        const body = asRecord(res.body);
        return res.status === 200 && body?.success === true && asRecord(body.data) ? 'newapi' : 'sub2api';
      } catch {
        return 'newapi';
      }
    },
  };
}
