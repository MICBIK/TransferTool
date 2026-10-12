import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auth } from '../db/schema.js';
import type { Clock } from './clock.js';
import { hashPassword, verifyPassword } from './password.js';

/** 站长密码哈希与会话版本号（auth 表只有 id=1 一行）。 */
export class AuthState {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly hashIterations?: number,
  ) {}

  private row() {
    return this.db.select().from(auth).where(eq(auth.id, 1)).get();
  }

  hasPassword(): boolean {
    return this.row() !== undefined;
  }

  /** 库里没有密码哈希时用初始密码创建；已有则不改动。返回是否新建。 */
  async initialize(initialPassword: string | undefined): Promise<boolean> {
    if (this.row()) return false;
    if (!initialPassword) throw new Error('数据库中还没有管理员密码，请设置环境变量 ADMIN_PASSWORD 后重新启动');
    const passwordHash = await hashPassword(initialPassword, this.hashIterations);
    this.db.insert(auth).values({ id: 1, passwordHash, sessionVersion: 1, updatedAt: this.clock() }).run();
    return true;
  }

  sessionVersion(): number {
    return this.row()?.sessionVersion ?? 0;
  }

  async verify(password: string): Promise<boolean> {
    const row = this.row();
    if (!row) return false;
    return verifyPassword(password, row.passwordHash);
  }

  /** 修改密码并使所有旧会话失效（会话版本号 +1），返回新版本号。 */
  async changePassword(newPassword: string): Promise<number> {
    const row = this.row();
    if (!row) throw new Error('password not initialized');
    const passwordHash = await hashPassword(newPassword, this.hashIterations);
    const sessionVersion = row.sessionVersion + 1;
    this.db.update(auth).set({ passwordHash, sessionVersion, updatedAt: this.clock() }).where(eq(auth.id, 1)).run();
    return sessionVersion;
  }
}
