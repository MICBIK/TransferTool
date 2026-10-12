import { describe, expect, it } from 'vitest';
import { classifyChannel, hostOf } from '../src/services/channelClassifier.js';

const ups = [
  { id: 1, domains: ['api.up-a.com'] },
  { id: 2, domains: ['up-b.com', 'b-mirror.net'] },
  { id: 3, domains: ['v1.up-b.com'] },
];

describe('渠道自动归类', () => {
  it('主机名相等或为子域则归属', () => {
    expect(classifyChannel('https://api.up-a.com/v1', ups)).toBe(1);
    expect(classifyChannel('https://UP-B.com', ups)).toBe(2);
    expect(classifyChannel('https://cdn.eu.up-b.com:8443/x', ups)).toBe(2);
    expect(classifyChannel('http://b-mirror.net', ups)).toBe(2);
  });

  it('不是子域的相似域名不归类（后缀碰撞）', () => {
    expect(classifyChannel('https://notup-b.com', ups)).toBeNull();
    expect(classifyChannel('https://up-b.com.evil.io', ups)).toBeNull();
    expect(classifyChannel('https://up-a.com', ups)).toBeNull(); // 父域不算
  });

  it('多个上游都匹配时取最具体的匹配域名', () => {
    expect(classifyChannel('https://v1.up-b.com', ups)).toBe(3);
    expect(classifyChannel('https://x.v1.up-b.com', ups)).toBe(3);
  });

  it('base_url 为空（官方默认端点）或无法解析时不归类', () => {
    expect(classifyChannel('', ups)).toBeNull();
    expect(classifyChannel('   ', ups)).toBeNull();
    expect(classifyChannel('http://', ups)).toBeNull();
  });

  it('容忍缺协议、尾点和端口', () => {
    expect(hostOf('api.up-a.com/v1')).toBe('api.up-a.com');
    expect(hostOf('https://api.up-a.com.:3000')).toBe('api.up-a.com');
    expect(classifyChannel('api.up-a.com/v1', ups)).toBe(1);
  });

  it('IP 只做相等匹配', () => {
    const ip = [{ id: 9, domains: ['1.2.3.4'] }];
    expect(classifyChannel('http://1.2.3.4:3000', ip)).toBe(9);
    expect(classifyChannel('http://11.2.3.4', ip)).toBeNull();
  });
});
