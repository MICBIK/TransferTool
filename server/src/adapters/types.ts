import type { Clock } from '../services/clock.js';

export type UpstreamType = 'newapi' | 'sub2api';
export type FetchFn = typeof fetch;

/** 适配器看到的上游：凭证已解密，仅在内存中短暂存在。 */
export interface AdapterUpstream {
  type: UpstreamType;
  /** 已规范化（无尾部斜杠，仅 http/https） */
  siteUrl: string;
  credential: string;
  /** new-api 用户 ID（New-Api-User 头）；没填时可用登录账号密码自动获取 */
  userId?: string;
  /** 上游登录账号与密码（可选）：新版 new-api 要求用户 ID 时，用它登录一次拿到 ID */
  account?: string;
  password?: string;
  /** 汇率系数：站内美元 × 系数 = 实际折算美元 */
  rateFactor: number;
}

/**
 * 余额含义：
 *  - wallet：钱包余额（new-api 用户余额、sub2api unrestricted）
 *  - key_limit：sub2api quota_limited 的 Key 限额剩余，不是钱包余额
 */
export type BalanceKind = 'wallet' | 'key_limit';

export interface BalanceResult {
  ok: boolean;
  balanceUsd?: number;
  /** 'newapi' | 'unrestricted' | 'quota_limited' | 'subscription' | 'unknown' */
  mode: string;
  kind?: BalanceKind;
  /** 仅数值/模式类字段，绝不含凭证 */
  raw?: Record<string, unknown>;
  error?: string;
  /** 上游是订阅制：不是错误，也不触发提醒 */
  unsupported?: boolean;
  /** 本次通过登录自动获取到的 new-api 用户 ID，调用方应保存下来，下次直接使用 */
  discoveredUserId?: string;
}

export interface FetchContext {
  /** 外部取消信号（进程关闭时中止在途请求） */
  signal?: AbortSignal;
}

export interface Adapter {
  fetchBalance(upstream: AdapterUpstream, ctx?: FetchContext): Promise<BalanceResult>;
}

export interface AdapterDeps {
  fetch: FetchFn;
  clock: Clock;
  timeoutMs?: number;
}
