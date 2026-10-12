import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/services/password.js';

describe('密码哈希', () => {
  it('默认迭代次数不低于 210000，正确密码通过、错误密码拒绝', async () => {
    const stored = await hashPassword('s3cret-密码');
    const iterations = Number(stored.split('$')[1]);
    expect(iterations).toBeGreaterThanOrEqual(210_000);
    expect(stored.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(stored).not.toContain('s3cret');
    expect(await verifyPassword('s3cret-密码', stored)).toBe(true);
    expect(await verifyPassword('s3cret-密码 ', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('同一密码每次哈希不同（随机盐）', async () => {
    const a = await hashPassword('same', 1000);
    const b = await hashPassword('same', 1000);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('格式损坏的哈希一律校验失败而不抛异常', async () => {
    for (const bad of ['', 'plain', 'pbkdf2-sha256$x$y$z', 'pbkdf2-sha256$1000$$', 'md5$1$a$b', 'pbkdf2-sha256$0$YQ==$YQ==']) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });

  it('被篡改的哈希值校验失败', async () => {
    const parts = (await hashPassword('pw', 1000)).split('$');
    const hash = Buffer.from(parts[3] as string, 'base64');
    hash[0] = (hash[0] ?? 0) ^ 1;
    parts[3] = hash.toString('base64');
    expect(await verifyPassword('pw', parts.join('$'))).toBe(false);
  });
});
