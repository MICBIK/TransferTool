import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loginCodes } from '../src/db/schema.js';
import { CODE_TTL_MS, EmailCodeService, HOURLY_LIMIT, MAX_CODE_ATTEMPTS, RESEND_INTERVAL_MS } from '../src/services/emailCode.js';
import { makeHarness } from './helpers.js';

async function setup() {
  const h = await makeHarness();
  const svc = new EmailCodeService(h.db, 'unit-test-secret-unit-test-secret!!', () => h.clock.now);
  return { h, svc };
}

function mustIssue(svc: EmailCodeService) {
  const r = svc.issue();
  if (!r.ok) throw new Error(`issue refused: ${r.reason}`);
  return r;
}

describe('邮件验证码', () => {
  it('生成 6 位数字（含前导 0），校验成功', async () => {
    const { svc } = await setup();
    const { code } = mustIssue(svc);
    expect(code).toMatch(/^\d{6}$/);
    expect(svc.verify(code)).toBe(true);
  });

  it('只存哈希，库里查不到明文', async () => {
    const { h, svc } = await setup();
    const { code } = mustIssue(svc);
    const rows = h.db.select().from(loginCodes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('一次性：成功使用后再次使用失败', async () => {
    const { svc } = await setup();
    const { code } = mustIssue(svc);
    expect(svc.verify(code)).toBe(true);
    expect(svc.verify(code)).toBe(false);
  });

  it('5 分钟有效，过期失败', async () => {
    const { h, svc } = await setup();
    const { code } = mustIssue(svc);
    h.clock.now += CODE_TTL_MS - 1;
    expect(svc.verify(code)).toBe(true);

    const second = mustIssue(svc);
    h.clock.now += CODE_TTL_MS;
    expect(svc.verify(second.code)).toBe(false);
  });

  it('错误验证码失败，格式不对直接失败', async () => {
    const { svc } = await setup();
    const { code } = mustIssue(svc);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(svc.verify(wrong)).toBe(false);
    expect(svc.verify('12345')).toBe(false);
    expect(svc.verify('abcdef')).toBe(false);
    expect(svc.verify('')).toBe(false);
    expect(svc.verify(code)).toBe(true);
  });

  it('同一验证码连续错误 5 次后作废', async () => {
    const { svc } = await setup();
    const { code } = mustIssue(svc);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) expect(svc.verify(wrong)).toBe(false);
    expect(svc.verify(code)).toBe(false);
  });

  it('60 秒内只能发一次', async () => {
    const { h, svc } = await setup();
    mustIssue(svc);
    h.clock.now += RESEND_INTERVAL_MS - 1000;
    const r = svc.issue();
    expect(r).toMatchObject({ ok: false, reason: 'too_soon', retryAfterSeconds: 1 });
    h.clock.now += 1000;
    expect(svc.issue().ok).toBe(true);
  });

  it('每小时最多 5 次', async () => {
    const { h, svc } = await setup();
    for (let i = 0; i < HOURLY_LIMIT; i++) {
      mustIssue(svc);
      h.clock.now += RESEND_INTERVAL_MS;
    }
    const refused = svc.issue();
    expect(refused).toMatchObject({ ok: false, reason: 'hourly_limit' });
    // 第 1 次发送满 1 小时后才能再发
    h.clock.now = 1_700_000_000_000 + 60 * 60 * 1000;
    expect(svc.issue().ok).toBe(true);
  });

  it('发新码后旧码作废', async () => {
    const { h, svc } = await setup();
    const first = mustIssue(svc);
    h.clock.now += RESEND_INTERVAL_MS;
    const second = mustIssue(svc);
    if (first.code !== second.code) expect(svc.verify(first.code)).toBe(false);
    expect(svc.verify(second.code)).toBe(true);
  });

  it('撤销后不可用，但仍计入频率限制', async () => {
    const { h, svc } = await setup();
    const { code, id } = mustIssue(svc);
    svc.revoke(id);
    expect(svc.verify(code)).toBe(false);
    expect(svc.issue()).toMatchObject({ ok: false, reason: 'too_soon' });
    expect(h.db.select().from(loginCodes).where(eq(loginCodes.id, id)).get()?.used).toBe(true);
  });
});
