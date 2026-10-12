import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

const ALGO = 'pbkdf2-sha256';
const DEFAULT_ITERATIONS = 600_000; // 高于规格要求的 210000
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** 格式：pbkdf2-sha256$<迭代次数>$<salt base64>$<hash base64> */
export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2Async(password, salt, iterations, KEY_BYTES, 'sha256');
  return `${ALGO}$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGO) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = Buffer.from(parts[2] ?? '', 'base64');
  const expected = Buffer.from(parts[3] ?? '', 'base64');
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = await pbkdf2Async(password, salt, iterations, KEY_BYTES, 'sha256');
  return timingSafeEqual(actual, expected);
}
