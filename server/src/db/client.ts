import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): void;
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** 打开数据库并自动执行迁移。file 传 ':memory:' 用于测试。 */
export function openDatabase(file: string): DbHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => sqlite.close() };
}

export function dbFileFor(dataDir: string): string {
  return join(dataDir, 'transfertool.db');
}
