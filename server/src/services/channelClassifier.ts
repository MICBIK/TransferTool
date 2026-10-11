export interface UpstreamDomains {
  id: number;
  domains: string[];
}

/** 取渠道 base_url 的小写主机名；允许缺协议（如 api.example.com/v1）。空串/无法解析返回 null。 */
export function hostOf(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (!text) return null;
  try {
    const host = new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase().replace(/\.$/, '');
    return host || null;
  } catch {
    return null;
  }
}

/** host 等于 domain，或是 domain 的子域。 */
export function hostMatches(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  return d !== '' && (host === d || host.endsWith(`.${d}`));
}

/**
 * 自动归类：渠道 base_url 的主机名与某上游“匹配域名”任一相等或为其子域，则归属该上游。
 * 多个上游都能匹配时取匹配域名最长（最具体）的；仍相同取 id 最小的。
 * base_url 为空（官方默认端点）或无法解析时不归类。
 */
export function classifyChannel(baseUrl: string, upstreams: UpstreamDomains[]): number | null {
  const host = hostOf(baseUrl);
  if (!host) return null;
  let best: { id: number; len: number } | null = null;
  for (const u of upstreams) {
    for (const domain of u.domains) {
      if (!hostMatches(host, domain)) continue;
      const len = domain.length;
      if (!best || len > best.len || (len === best.len && u.id < best.id)) best = { id: u.id, len };
    }
  }
  return best?.id ?? null;
}
