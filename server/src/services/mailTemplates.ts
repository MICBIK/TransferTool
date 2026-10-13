/**
 * HTML 邮件模板。邮件客户端对 CSS 支持很差（Gmail 去掉 <style>、Outlook 用 Word 渲染），
 * 所以只用表格布局 + 行内样式，颜色全部写死并显式给背景色，避免被深色模式反色后看不清。
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Helvetica,Arial,sans-serif";

export const COLORS = {
  page: '#f4f4f2',
  card: '#ffffff',
  border: '#e7e6e2',
  text: '#1f1f1d',
  muted: '#6b6a66',
  brand: '#18a058',
  critical: '#d03b3b',
  criticalBg: '#fdf0f0',
  warning: '#c27c00',
  warningBg: '#fdf6e7',
  info: '#2a78d6',
  infoBg: '#eef5fd',
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 只允许 http(s) 链接进 href，其余一律不生成链接。 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function button(label: string, href: string, color: string = COLORS.brand): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${color}" style="border-radius:6px;background:${color}">
<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:9px 18px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a>
</td></tr></table>`;
}

export function pill(label: string, color: string, bg: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${color};font-size:12px;font-weight:600;line-height:18px;white-space:nowrap">${escapeHtml(label)}</span>`;
}

/**
 * 整封邮件的外壳：顶部品牌条（颜色表示严重程度）、标题、正文、页脚。
 * preheader 是收件箱列表里标题后面那行预览文字。
 */
export function layout(opts: { accent: string; title: string; preheader: string; body: string; footer?: string }): string {
  const footer = opts.footer ?? '这封邮件由 TransferTool 自动发送，直接回复不会有人看到。';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLORS.page}">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background:${COLORS.page}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 4px 12px;font-family:${FONT};font-size:14px;font-weight:700;color:${COLORS.text}">TransferTool</td></tr>
<tr><td bgcolor="${COLORS.card}" style="background:${COLORS.card};border:1px solid ${COLORS.border};border-top:4px solid ${opts.accent};border-radius:8px;padding:24px;font-family:${FONT};color:${COLORS.text}">
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:700;color:${COLORS.text}">${escapeHtml(opts.title)}</h1>
${opts.body}
</td></tr>
<tr><td style="padding:14px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${COLORS.muted}">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function paragraph(html: string, extra = ''): string {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${COLORS.text};${extra}">${html}</p>`;
}
