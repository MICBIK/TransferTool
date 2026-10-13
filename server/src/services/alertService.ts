import { BURN_WINDOW_MS, estimateBurn } from './burnRate.js';
import { decideAlert, type AlertReason, type AlertRecord, type AlertState } from './alertMachine.js';
import type { BalanceStore } from './balanceStore.js';
import type { Clock } from './clock.js';
import { COLORS, button, escapeHtml, layout, paragraph, pill, safeHref } from './mailTemplates.js';
import { MailerError, type Mailer } from './mailer.js';
import type { SettingsStore } from './settings.js';
import type { UpstreamRow } from './upstreams.js';

export const DEFAULT_ALERT_REPEAT_HOURS = 6;

export function alertRepeatHours(settings: SettingsStore): number {
  const n = Number(settings.get('alert_repeat_hours'));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_ALERT_REPEAT_HOURS;
}

export interface AlertItem {
  name: string;
  type: UpstreamRow['type'];
  state: Exclude<AlertState, 'normal'>;
  reason: AlertReason;
  balanceUsd: number;
  keyLimit: boolean;
  threshold: number;
  emergencyThreshold: number | null;
  burnUsdPerDay: number | null;
  exhaustAt: number | null;
  topupUrl: string | null;
}

export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** 与总览页一致的“预计可用时长”文案。 */
export function formatEta(exhaustAt: number | null, now: number): string {
  if (exhaustAt === null) return '无法估算（样本不足或近期无消耗）';
  const hours = Math.max(0, (exhaustAt - now) / 3600_000);
  const span = hours >= 48 ? `约 ${(hours / 24).toFixed(1)} 天` : hours >= 1 ? `约 ${hours.toFixed(1)} 小时` : '不足 1 小时';
  return `${span}后（${new Date(exhaustAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}）`;
}

const typeLabel = (t: AlertItem['type']) => (t === 'newapi' ? 'new-api' : 'sub2api');

/** 多个上游同一轮跌破时合并成一封邮件（HTML 为主，附纯文字版）。紧急的排前面。 */
export function buildAlertMail(items: AlertItem[], now: number, opts: { repeatHours?: number } = {}): { subject: string; text: string; html: string } {
  const sorted = [...items].sort((a, b) => (a.state === 'critical' ? 0 : 1) - (b.state === 'critical' ? 0 : 1) || a.balanceUsd - b.balanceUsd);
  const critical = sorted.some((i) => i.state === 'critical');
  const names = sorted.slice(0, 3).map((i) => i.name).join('、') + (sorted.length > 3 ? ` 等 ${sorted.length} 个上游` : '');
  const subject = `[TransferTool] ${critical ? '紧急：上游余额即将耗尽' : '上游余额不足'}（${names}）`;
  const blocks = sorted.map((i) => {
    const lines = [
      `■ ${i.state === 'critical' ? '【紧急】' : ''}${i.name}（${typeLabel(i.type)}）`,
      `  当前余额：${usd(i.balanceUsd)}${i.keyLimit ? '（这是 Key 限额，不是钱包余额）' : ''}`,
      `  提醒阈值：${usd(i.threshold)}${i.emergencyThreshold !== null ? `；紧急阈值：${usd(i.emergencyThreshold)}` : ''}`,
      `  预计耗尽：${formatEta(i.exhaustAt, now)}${i.burnUsdPerDay !== null ? `，近 24 小时消耗约 ${usd(i.burnUsdPerDay)}/天` : ''}`,
    ];
    if (i.topupUrl) lines.push(`  充值页：${i.topupUrl}`);
    return lines.join('\n');
  });
  const text = `以下上游余额已低于提醒阈值：\n\n${blocks.join('\n\n')}\n\n—— TransferTool`;

  const critCount = sorted.filter((i) => i.state === 'critical').length;
  const title = sorted.length === 1 ? `${sorted[0]!.name} ${critical ? '余额即将耗尽' : '余额不足'}` : `${sorted.length} 个上游余额不足${critCount ? `，其中 ${critCount} 个紧急` : ''}`;
  const intro = critical ? '有上游余额已低于紧急阈值，请尽快充值，否则相关渠道会停止服务。' : '以下上游余额已低于提醒阈值，建议近期充值。';
  const repeat = opts.repeatHours ? `余额一直低于阈值时，每 ${opts.repeatHours} 小时提醒一次；充值恢复后自动停止。` : '';
  const html = layout({
    accent: critical ? COLORS.critical : COLORS.warning,
    title,
    preheader: sorted.map((i) => `${i.name} ${usd(i.balanceUsd)}`).join('，'),
    body: paragraph(escapeHtml(intro), `color:${COLORS.muted}`) + sorted.map((i) => alertCard(i, now)).join(''),
    footer: `${repeat}这封邮件由 TransferTool 自动发送。`,
  });
  return { subject, text, html };
}

function alertCard(i: AlertItem, now: number): string {
  const crit = i.state === 'critical';
  const color = crit ? COLORS.critical : COLORS.warning;
  const bg = crit ? COLORS.criticalBg : COLORS.warningBg;
  const line = crit && i.emergencyThreshold !== null ? i.emergencyThreshold : i.threshold;
  const fill = Math.max(2, Math.min(100, Math.round((i.balanceUsd / Math.max(i.threshold, 0.01)) * 100)));
  const hoursLeft = i.exhaustAt === null ? null : (i.exhaustAt - now) / 3600_000;
  const etaColor = hoursLeft !== null && hoursLeft < 24 ? COLORS.critical : COLORS.text;
  const row = (k: string, v: string, vStyle = '') =>
    `<tr><td style="padding:4px 0;font-size:13px;color:${COLORS.muted};width:84px;vertical-align:top">${k}</td><td style="padding:4px 0;font-size:13px;color:${COLORS.text};${vStyle}">${v}</td></tr>`;
  const href = safeHref(i.topupUrl);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;border:1px solid ${COLORS.border};border-left:4px solid ${color};border-radius:6px">
<tr><td style="padding:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-size:16px;font-weight:700;color:${COLORS.text}">${escapeHtml(i.name)} <span style="font-size:12px;font-weight:400;color:${COLORS.muted}">${typeLabel(i.type)}</span></td>
<td align="right">${pill(crit ? '紧急' : i.keyLimit ? 'Key 额度不足' : '余额不足', color, bg)}</td>
</tr></table>
<div style="margin:10px 0 2px;font-size:30px;line-height:36px;font-weight:700;color:${color}">${usd(i.balanceUsd)}</div>
<div style="font-size:12px;color:${COLORS.muted}">${i.keyLimit ? '这是 Key 的剩余额度，不是账户余额 · ' : ''}已低于${crit && i.emergencyThreshold !== null ? '紧急' : '提醒'}阈值 ${usd(line)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 12px"><tr>
<td width="${fill}%" height="6" bgcolor="${color}" style="background:${color};height:6px;font-size:0;line-height:0;border-radius:3px 0 0 3px">&nbsp;</td>
<td height="6" bgcolor="${COLORS.border}" style="background:${COLORS.border};height:6px;font-size:0;line-height:0;border-radius:0 3px 3px 0">&nbsp;</td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${row('预计耗尽', escapeHtml(formatEta(i.exhaustAt, now)), `font-weight:600;color:${etaColor}`)}
${i.burnUsdPerDay !== null ? row('消耗速度', `约 ${usd(i.burnUsdPerDay)}/天（近 24 小时）`) : ''}
${row('阈值', `提醒 ${usd(i.threshold)}${i.emergencyThreshold !== null ? ` · 紧急 ${usd(i.emergencyThreshold)}` : ''}`)}
</table>
${href ? `<div style="margin-top:14px">${button('去充值', href, color)}</div>` : ''}
</td></tr></table>`;
}

export interface AlertCandidate {
  upstream: UpstreamRow;
  /** 本轮查询得到的余额（已按汇率换算）；失败/未知为 null */
  balanceUsd: number | null;
  keyLimit: boolean;
}

/** 把状态机的判定落到数据库，并把同一轮的多个提醒合并为一封邮件。 */
export class AlertService {
  constructor(
    private readonly deps: { store: BalanceStore; mailer: Mailer; settings: SettingsStore; clock: Clock },
  ) {}

  async process(candidates: AlertCandidate[]): Promise<{ sent: number }> {
    const { store, settings, clock } = this.deps;
    const now = clock();
    const repeatIntervalMs = alertRepeatHours(settings) * 3600_000;
    const pending: { id: number; next: AlertRecord; item: AlertItem }[] = [];

    for (const c of candidates) {
      const stored = store.getAlert(c.upstream.id);
      const prev: AlertRecord = stored ? { state: stored.state, lastSentAt: stored.lastSentAt } : { state: 'normal', lastSentAt: null };
      const d = decideAlert({
        prev,
        balanceUsd: c.balanceUsd,
        threshold: c.upstream.threshold,
        emergencyThreshold: c.upstream.emergencyThreshold,
        now,
        repeatIntervalMs,
      });
      if (!d.send || c.balanceUsd === null || d.next.state === 'normal' || d.reason === null) {
        // 状态有变化但无需发信（恢复、critical→low 等）直接落库；保留上次发信结果
        if (d.next.state !== prev.state || d.next.lastSentAt !== prev.lastSentAt) store.saveAlert(c.upstream.id, d.next, stored?.lastResult ?? null, now);
        continue;
      }
      const burn = estimateBurn(store.points(c.upstream.id, now - BURN_WINDOW_MS), now);
      pending.push({
        id: c.upstream.id,
        next: d.next,
        item: {
          name: c.upstream.name,
          type: c.upstream.type,
          state: d.next.state,
          reason: d.reason,
          balanceUsd: c.balanceUsd,
          keyLimit: c.keyLimit,
          threshold: c.upstream.threshold,
          emergencyThreshold: c.upstream.emergencyThreshold,
          burnUsdPerDay: burn.usdPerDay,
          exhaustAt: burn.exhaustAt,
          topupUrl: c.upstream.topupUrl ?? (c.upstream.type === 'newapi' ? `${c.upstream.siteUrl}/console/topup` : null),
        },
      });
    }
    if (pending.length === 0) return { sent: 0 };

    const mail = buildAlertMail(pending.map((p) => p.item), now, { repeatHours: alertRepeatHours(settings) });
    try {
      await this.deps.mailer.sendToAdmin(mail.subject, mail.text, { html: mail.html });
    } catch (err) {
      // 发信失败：不提交新状态，下一轮会再次判定为需要发送（失败的查询才不算跌破，发信失败要重试）
      const why = err instanceof MailerError ? err.message : '邮件发送失败';
      for (const p of pending) store.setAlertResult(p.id, `${why}，将在下次刷新时重试`, now);
      console.error(`[alert] ${why}`);
      return { sent: 0 };
    }
    for (const p of pending) store.saveAlert(p.id, p.next, `已发送（${p.item.reason}）`, now);
    return { sent: pending.length };
  }
}
