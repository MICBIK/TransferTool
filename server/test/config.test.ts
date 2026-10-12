import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const good = () => ({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: 'x'.repeat(40),
  ADMIN_PASSWORD: 'pw',
});

describe('loadConfig', () => {
  it('读取必填项并应用默认值', () => {
    const c = loadConfig(good());
    expect(c.port).toBe(3000);
    expect(c.dataDir).toBe('/data');
    expect(c.cookieSecure).toBe(true);
    expect(c.emergencyPassword).toBeUndefined();
    expect(c.encryptionKey.length).toBe(32);
  });

  it('缺少 ENCRYPTION_KEY / SESSION_SECRET 时报错', () => {
    expect(() => loadConfig({ ...good(), ENCRYPTION_KEY: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), SESSION_SECRET: undefined })).toThrow(ConfigError);
  });

  it('无效密钥与过短的 SESSION_SECRET 被拒绝，且错误信息不回显取值', () => {
    expect(() => loadConfig({ ...good(), ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/ENCRYPTION_KEY/);
    try {
      loadConfig({ ...good(), SESSION_SECRET: 'short-but-secret' });
    } catch (e) {
      expect((e as Error).message).toMatch(/SESSION_SECRET/);
      expect((e as Error).message).not.toContain('short-but-secret');
    }
  });

  it('COOKIE_SECURE=false 与非法端口', () => {
    expect(loadConfig({ ...good(), COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(() => loadConfig({ ...good(), COOKIE_SECURE: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), PORT: '99999' })).toThrow(ConfigError);
  });
});
