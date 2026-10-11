import type { Clock } from '../services/clock.js';

export type UpstreamType = 'newapi' | 'sub2api';
export type FetchFn = typeof fetch;

/** 适配器看到的上游：凭证已解密，仅在内存中短暂存在。 */
export interface AdapterUpstream {
  type: UpstreamType;
  /** 已规范化（无尾部斜杠，仅 http/https） */
  siteUrl: string;
  credential: string;
  /** new-api 用户 ID（New-Api-User 头） */
  userId?: string;
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
