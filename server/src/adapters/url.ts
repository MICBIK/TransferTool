export class UrlError extends Error {}

function parseHttpUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlError(`${what}不是有效的 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlError(`${what}只支持 http 或 https`);
  if (url.username || url.password) throw new UrlError(`${what}不能包含账号密码`);
  if (!url.hostname) throw new UrlError(`${what}缺少主机名`);
  return url;
}

/**
 * 规范化站点地址：去掉首尾空白与尾部斜杠，只允许 http/https，
 * 拒绝内嵌账号密码，丢弃查询串与片段。
 */
export function normalizeSiteUrl(raw: string): string {
  const url = parseHttpUrl(raw, '站点地址');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** 规范化可选链接（充值页）：同样只允许 http/https；保留查询串，丢弃片段；空串返回 null。 */
export function normalizeOptionalUrl(raw: string | null | undefined, what = '链接'): string | null {
  if (!raw?.trim()) return null;
  const url = parseHttpUrl(raw, what);
  url.hash = '';
  return url.toString();
}

/** 把用户输入的匹配域名清洗成小写主机名（接受带协议/端口/路径的粘贴内容）。 */
export function normalizeDomain(raw: string): string | null {
  let text = raw.trim().toLowerCase();
  if (!text) return null;
  if (!text.includes('://')) text = `http://${text}`;
  try {
    const host = new URL(text).hostname.replace(/\.$/, '');
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
  } catch {
    return null;
  }
}
