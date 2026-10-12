import { describe, expect, it } from 'vitest';
import { LoginGuard, LOCK_MS, MAX_FAILURES } from '../src/services/loginGuard.js';
import { makeHarness } from './helpers.js';

async function setup() {
  const h = await makeHarness();
  return { h, guard: new LoginGuard(h.db, () => h.clock.now) };
}

describe('登录锁定', () => {
  it('连续失败 5 次锁定 15 分钟，第 4 次之前不锁', async () => {
    const { guard } = await setup();
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect(guard.recordFailure('1.1.1.1').locked).toBe(false);
      expect(guard.check('1.1.1.1').locked).toBe(false);
    }
    expect(guard.recordFailure('1.1.1.1').locked).toBe(true);
    const status = guard.check('1.1.1.1');
    expect(status.locked).toBe(true);
    expect(status.retryAfterSeconds).toBe(15 * 60);
  });

  it('锁定 15 分钟后自动解除', async () => {
    const { h, guard } = await setup();
    for (let i = 0; i < MAX_FAILURES; i++) guard.recordFailure('1.1.1.1');
    h.clock.now += LOCK_MS - 1000;
    expect(guard.check('1.1.1.1').locked).toBe(true);
    h.clock.now += 1000;
    expect(guard.check('1.1.1.1').locked).toBe(false);
    // 解除后重新计数，不是一次失败就再锁
    expect(guard.recordFailure('1.1.1.1').locked).toBe(false);
  });

  it('按 IP 隔离', async () => {
    const { guard } = await setup();
    for (let i = 0; i < MAX_FAILURES; i++) guard.recordFailure('1.1.1.1');
    expect(guard.check('1.1.1.1').locked).toBe(true);
    expect(guard.check('2.2.2.2').locked).toBe(false);
  });

  it('成功登录清零失败计数', async () => {
    const { guard } = await setup();
    for (let i = 0; i < MAX_FAILURES - 1; i++) guard.recordFailure('1.1.1.1');
    guard.recordSuccess('1.1.1.1');
    for (let i = 0; i < MAX_FAILURES - 1; i++) expect(guard.recordFailure('1.1.1.1').locked).toBe(false);
  });

  it('距上次失败超过 15 分钟不再算“连续”', async () => {
    const { h, guard } = await setup();
    for (let i = 0; i < MAX_FAILURES - 1; i++) guard.recordFailure('1.1.1.1');
    h.clock.now += LOCK_MS + 1;
    expect(guard.recordFailure('1.1.1.1').locked).toBe(false);
  });
});
