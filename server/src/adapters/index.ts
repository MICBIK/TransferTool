import { createNewApiAdapter } from './newapi.js';
import { createSub2ApiAdapter } from './sub2api.js';
import type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, FetchContext } from './types.js';

export type { Adapter, AdapterDeps, AdapterUpstream, BalanceResult, BalanceKind, FetchContext, FetchFn, UpstreamType } from './types.js';
export { createOwnSiteClient, OLD_VERSION_MESSAGE, type SiteErrorKind, type ChannelStatus, type ChannelTestResult, type OwnSiteClient, type OwnSiteConn, type SiteChannel, type SiteResult, type StatusManyResult } from './ownsite.js';
export { normalizeDomain, normalizeOptionalUrl, normalizeSiteUrl, UrlError } from './url.js';

/** 按上游类型分发。外部请求全部经注入的 fetch，便于测试。 */
export function createAdapters(deps: AdapterDeps): { fetchBalance(upstream: AdapterUpstream, ctx?: FetchContext): Promise<BalanceResult> } {
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
  };
}
