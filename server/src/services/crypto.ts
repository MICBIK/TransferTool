import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseEncryptionKey(b64: string): Buffer {
  const trimmed = b64.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32 || key.toString('base64') !== trimmed) {
    throw new Error('encryption key must be 32 bytes, base64 encoded');
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * AES-256-GCM。格式：enc:v1:<iv base64>:<密文+认证标签 base64>。
 * aad（附加认证数据）用于把密文绑定到具体用途（如设置项的键名），防止密文被换位使用。
 */
export function encrypt(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
}

export function decrypt(payload: string, key: Buffer, aad?: string): string {
  if (!isEncrypted(payload)) throw new Error('not an encrypted value');
  const parts = payload.slice(PREFIX.length).split(':');
  if (parts.length !== 2) throw new Error('malformed encrypted value');
  const iv = Buffer.from(parts[0] ?? '', 'base64');
  const body = Buffer.from(parts[1] ?? '', 'base64');
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error('malformed encrypted value');
  const ct = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // 不透出底层错误细节
    throw new Error('decryption failed: wrong key or tampered data');
  }
}

/** 常量时间字符串比较：先各自哈希成定长摘要再比较，长度差异也不泄露。 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function hmacHex(secret: string, label: string, data: string): string {
  return createHmac('sha256', createHash('sha256').update(`${label}:${secret}`).digest()).update(data).digest('hex');
}

export function hmacBase64Url(secret: string, label: string, data: string): string {
  return createHmac('sha256', createHash('sha256').update(`${label}:${secret}`).digest()).update(data).digest('base64url');
}
