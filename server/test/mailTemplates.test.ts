import { describe, expect, it } from 'vitest';
import { buildAlertMail, type AlertItem } from '../src/services/alertService.js';
import { Mailer, type MailMessage } from '../src/services/mailer.js';
import { escapeHtml, safeHref } from '../src/services/mailTemplates.js';

const now = Date.UTC(2026, 9, 13, 12);
const item = (over: Partial<AlertItem> = {}): AlertItem => ({
  name: '上游A',
  type: 'newapi',
  state: 'low',
  reason: 'crossed_low',
  balanceUsd: 8,
  keyLimit: false,
  threshold: 10,
  emergencyThreshold: 3,
  burnUsdPerDay: 2,
  exhaustAt: now + 4 * 24 * 3600_000,
  topupUrl: 'https://a.example.com/console/topup',
  ...over,
});

describe('提醒邮件 HTML', () => {
  it('同时给出纯文字版与 HTML 版，紧急的排在前面', () => {
    const m = buildAlertMail([item(), item({ name: '上游B', state: 'critical', balanceUsd: 1 })], now, { repeatHours: 6 });
    expect(m.subject).toBe('[TransferTool] 紧急：上游余额即将耗尽（上游B、上游A）');
    expect(m.text).toContain('$8.00');
    expect(m.html).toContain('2 个上游余额不足，其中 1 个紧急');
    expect(m.html.indexOf('上游B')).toBeLessThan(m.html.indexOf('上游A'));
    expect(m.html).toContain('href="https://a.example.com/console/topup"');
    expect(m.html).toContain('每 6 小时提醒一次');
  });

  it('上游名称会转义；非 http(s) 的充值链接不生成按钮', () => {
    const m = buildAlertMail([item({ name: '<b>x</b>', topupUrl: 'javascript:alert(1)' })], now);
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).not.toContain('javascript:');
    expect(m.html).not.toContain('去充值');
  });

  it('Key 限额写明不是账户余额', () => {
    const m = buildAlertMail([item({ keyLimit: true, type: 'sub2api', topupUrl: null })], now);
    expect(m.html).toContain('Key 额度不足');
    expect(m.html).toContain('不是账户余额');
  });

  it('escapeHtml / safeHref', () => {
    expect(escapeHtml(`a&"'<>`)).toBe('a&amp;&quot;&#39;&lt;&gt;');
    expect(safeHref('https://x.example/a?b=1')).toBe('https://x.example/a?b=1');
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('登录验证码与测试邮件都带 HTML', async () => {
    const sent: MailMessage[] = [];
    const settings = { get: (k: string) => ({ smtp_host: 'smtp.example.com', smtp_from: 'a@example.com', admin_email: 'o@example.com' })[k] };
    const mailer = new Mailer(settings as never, () => ({ sendMail: async (m: MailMessage) => void sent.push(m) }));
    await mailer.sendLoginCode('123456');
    await mailer.sendTest();
    expect(sent[0]!.text).toContain('123456');
    expect(sent[0]!.html).toContain('123456');
    expect(sent[1]!.html).toContain('邮件配置正常');
  });
});
