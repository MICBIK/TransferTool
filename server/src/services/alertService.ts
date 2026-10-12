import { BURN_WINDOW_MS, estimateBurn } from './burnRate.js';
import { decideAlert, type AlertReason, type AlertRecord, type AlertState } from './alertMachine.js';
import type { BalanceStore } from './balanceStore.js';
import type { Clock } from './clock.js';
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
  return `${span}后（${new Date(exhaustAt).toLocaleString('zh-CN', { hour12: false })}）`;
}

/** 多个上游同一轮跌破时合并成一封邮件。 */
export function buildAlertMail(items: AlertItem[], now: number): { subject: string; text: string } {
  const critical = items.some((i) => i.state === 'critical');
  const names = items.slice(0, 3).map((i) => i.name).join('、') + (items.length > 3 ? ` 等 ${items.length} 个上游` : '');
  const subject = `[TransferTool] ${critical ? '紧急：上游余额即将耗尽' : '上游余额不足'}（${names}）`;
  const blocks = items.map((i) => {
    const lines = [
      `■ ${i.state === 'critical' ? '【紧急】' : ''}${i.name}（${i.type === 'newapi' ? 'new-api' : 'sub2api'}）`,
      `  当前余额：${usd(i.balanceUsd)}${i.keyLimit ? '（这是 Key 限额，不是钱包余额）' : ''}`,
      `  提醒阈值：${usd(i.threshold)}${i.emergencyThreshold !== null ? `；紧急阈值：${usd(i.emergencyThreshold)}` : ''}`,
      `  预计耗尽：${formatEta(i.exhaustAt, now)}${i.burnUsdPerDay !== null ? `，近 24 小时消耗约 ${usd(i.burnUsdPerDay)}/天` : ''}`,
    ];
    if (i.topupUrl) lines.push(`  充值页：${i.topupUrl}`);
    return lines.join('\n');
  });
  return { subject, text: `以下上游余额已低于提醒阈值：\n\n${blocks.join('\n\n')}\n\n—— TransferTool` };
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

    const mail = buildAlertMail(pending.map((p) => p.item), now);
    try {
      await this.deps.mailer.sendToAdmin(mail.subject, mail.text);
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
