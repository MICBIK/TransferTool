import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEncryptionKey } from './services/crypto.js';

export interface AppConfig {
  port: number;
  dataDir: string;
  encryptionKey: Buffer;
  sessionSecret: string;
  adminPassword?: string;
  emergencyPassword?: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  webDist: string;
}

export class ConfigError extends Error {}

function parseBool(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  throw new ConfigError(`环境变量 ${name} 只能是 true 或 false`);
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

/** 从环境变量解析配置。错误信息只包含变量名，绝不回显变量值。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = nonEmpty(env.PORT) ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('环境变量 PORT 必须是 1-65535 的整数');
  }

  const keyRaw = nonEmpty(env.ENCRYPTION_KEY);
  if (!keyRaw) {
    throw new ConfigError('缺少必填环境变量 ENCRYPTION_KEY（32 字节 base64，可用 openssl rand -base64 32 生成）');
  }
  let encryptionKey: Buffer;
  try {
    encryptionKey = parseEncryptionKey(keyRaw);
  } catch {
    throw new ConfigError('环境变量 ENCRYPTION_KEY 无效：必须是 32 字节的 base64');
  }

  const sessionSecret = nonEmpty(env.SESSION_SECRET);
  if (!sessionSecret) {
    throw new ConfigError('缺少必填环境变量 SESSION_SECRET（至少 32 个字符）');
  }
  if (sessionSecret.length < 32) {
    throw new ConfigError('环境变量 SESSION_SECRET 太短：至少需要 32 个字符');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  return {
    port,
    dataDir: resolve(nonEmpty(env.DATA_DIR) ?? '/data'),
    encryptionKey,
    sessionSecret,
    adminPassword: nonEmpty(env.ADMIN_PASSWORD),
    emergencyPassword: nonEmpty(env.EMERGENCY_PASSWORD),
    cookieSecure: parseBool(env.COOKIE_SECURE, true, 'COOKIE_SECURE'),
    trustProxy: parseBool(env.TRUST_PROXY, true, 'TRUST_PROXY'),
    // src/ 与 dist/ 都位于 server/ 下，因此相对路径一致
    webDist: resolve(nonEmpty(env.WEB_DIST) ?? resolve(here, '../../web/dist')),
  };
}
