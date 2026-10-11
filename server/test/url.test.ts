import { describe, expect, it } from 'vitest';
import { normalizeDomain, normalizeOptionalUrl, normalizeSiteUrl } from '../src/adapters/index.js';

describe('站点地址规范化', () => {
  it('去空白与尾部斜杠，保留子路径', () => {
    expect(normalizeSiteUrl('  https://a.example.com/  ')).toBe('https://a.example.com');
    expect(normalizeSiteUrl('http://a.example.com:8080///')).toBe('http://a.example.com:8080');
    expect(normalizeSiteUrl('https://a.example.com/sub/')).toBe('https://a.example.com/sub');
    expect(normalizeSiteUrl('https://a.example.com/?x=1#f')).toBe('https://a.example.com');
  });
  it.each(['ftp://a.example.com', 'javascript:alert(1)', 'a.example.com', '', 'https://user:pw@a.example.com', 'file:///etc/passwd'])('拒绝 %s', (u) => {
    expect(() => normalizeSiteUrl(u)).toThrow();
  });
  it('充值页：可空，同样只允许 http(s)', () => {
    expect(normalizeOptionalUrl('')).toBeNull();
    expect(normalizeOptionalUrl('https://a.example.com/pay?x=1')).toBe('https://a.example.com/pay?x=1');
    expect(() => normalizeOptionalUrl('javascript:alert(1)')).toThrow();
  });
  it('匹配域名清洗', () => {
    expect(normalizeDomain(' HTTPS://Api.Example.com:8443/v1 ')).toBe('api.example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('bad domain!')).toBeNull();
  });
});
