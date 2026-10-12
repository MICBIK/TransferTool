import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, isEncrypted, parseEncryptionKey, safeEqual } from '../src/services/crypto.js';

const key = randomBytes(32);

describe('AES-256-GCM 加密', () => {
  it('加解密往返一致（含中文与空串）', () => {
    for (const text of ['hello', '中文 密码 🔑', '', 'x'.repeat(10_000)]) {
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    }
  });

  it('输出格式为 enc:v1:<iv>:<密文+标签>', () => {
    const out = encrypt('secret', key);
    expect(out).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(isEncrypted(out)).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(out).not.toContain('secret');
  });

  it('同一明文每次密文不同（随机 IV）', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('篡改密文会被检测到', () => {
    const parts = encrypt('secret', key).split(':');
    const body = Buffer.from(parts[3] as string, 'base64');
    body[0] = (body[0] ?? 0) ^ 0x01;
    expect(() => decrypt(`enc:v1:${parts[2]}:${body.toString('base64')}`, key)).toThrow();
  });

  it('篡改认证标签、IV 或截断都会失败', () => {
    const good = encrypt('secret', key);
    const parts = good.split(':');
    const body = Buffer.from(parts[3] as string, 'base64');
    const badTag = Buffer.from(body);
    badTag[badTag.length - 1] = (badTag[badTag.length - 1] ?? 0) ^ 0xff;
    expect(() => decrypt(`enc:v1:${parts[2]}:${badTag.toString('base64')}`, key)).toThrow();

    const badIv = Buffer.from(parts[2] as string, 'base64');
    badIv[0] = (badIv[0] ?? 0) ^ 0xff;
    expect(() => decrypt(`enc:v1:${badIv.toString('base64')}:${parts[3]}`, key)).toThrow();

    expect(() => decrypt(`enc:v1:${parts[2]}:${body.subarray(0, 8).toString('base64')}`, key)).toThrow();
    expect(() => decrypt('enc:v1:onlyonepart', key)).toThrow();
    expect(() => decrypt('not-encrypted', key)).toThrow();
  });

  it('错误的密钥无法解密', () => {
    expect(() => decrypt(encrypt('secret', key), randomBytes(32))).toThrow();
  });

  it('AAD 绑定用途：换位使用会失败', () => {
    const ct = encrypt('secret', key, 'smtp_pass');
    expect(decrypt(ct, key, 'smtp_pass')).toBe('secret');
    expect(() => decrypt(ct, key, 'other_key')).toThrow();
    expect(() => decrypt(ct, key)).toThrow();
  });

  it('解密错误信息不泄露内部细节', () => {
    const ct = encrypt('secret', key);
    try {
      decrypt(ct, randomBytes(32));
    } catch (err) {
      expect((err as Error).message).not.toContain('secret');
    }
  });
});

describe('parseEncryptionKey', () => {
  it('接受 32 字节 base64', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
  it('拒绝长度不对或非 base64', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow();
    expect(() => parseEncryptionKey('not base64 !!!')).toThrow();
    expect(() => parseEncryptionKey('')).toThrow();
  });
});

describe('safeEqual', () => {
  it('相等/不等/长度不同', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
