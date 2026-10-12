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

/** 常见的两段式公共后缀（如 com.cn），这些后缀下主域名取三段。 */
const TWO_LEVEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'com.tw', 'net.tw', 'org.tw', 'com.sg', 'com.my',
  'co.uk', 'org.uk', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'com.br',
]);

/**
 * 主机名的“主域名”（近似可注册域名）：api.llmgw.xyz → llmgw.xyz，a.b.example.com.cn → example.com.cn。
 * IP 地址与单段主机名原样返回。用于把同一家上游的多个子域名归成一组。
 */
export function baseDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const keep = TWO_LEVEL_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export interface UpstreamSuggestion {
  /** 主域名，作为建议的匹配域名 */
  domain: string;
  /** 建议的站点地址：这些渠道里最常见的 base_url 源（协议 + 主机 + 端口） */
  siteUrl: string;
  /** 出现过的具体主机名 */
  hosts: string[];
  channelCount: number;
  enabledCount: number;
  /** 最多 5 个渠道名，便于辨认 */
  sampleNames: string[];
}

/** 把未归类渠道按主域名分组，作为“可添加的上游”建议；渠道多的排前面。 */
export function suggestUpstreams(rows: { baseUrl: string; name: string; status: number }[]): UpstreamSuggestion[] {
  interface Group {
    origins: Map<string, number>;
    hosts: Set<string>;
    count: number;
    enabled: number;
    names: string[];
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const host = hostOf(r.baseUrl);
    if (!host) continue;
    let origin: string;
    try {
      const text = r.baseUrl.trim();
      origin = new URL(text.includes('://') ? text : `https://${text}`).origin.toLowerCase();
    } catch {
      continue;
    }
    const domain = baseDomain(host);
    const g: Group = groups.get(domain) ?? { origins: new Map<string, number>(), hosts: new Set<string>(), count: 0, enabled: 0, names: [] };
    g.origins.set(origin, (g.origins.get(origin) ?? 0) + 1);
    g.hosts.add(host);
    g.count++;
    if (r.status === 1) g.enabled++;
    if (g.names.length < 5) g.names.push(r.name);
    groups.set(domain, g);
  }
  return [...groups]
    .map(([domain, g]) => ({
      domain,
      siteUrl: [...g.origins].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      hosts: [...g.hosts].sort(),
      channelCount: g.count,
      enabledCount: g.enabled,
      sampleNames: g.names,
    }))
    .sort((a, b) => b.channelCount - a.channelCount || a.domain.localeCompare(b.domain));
}
