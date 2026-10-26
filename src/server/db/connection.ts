import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'libsql';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../schema.sql');
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

export type Db = Database.Database;

export interface DbOptions {
  syncUrl?: string;
  authToken?: string;
  syncPeriod?: number;
}

/** libsql returns pragma results as { name: value, _metadata }, even with simple. */
export function pragmaValue<T = number>(db: Db, source: string): T {
  const result = db.pragma(source, { simple: true }) as Record<string, unknown>;
  return Object.values(result)[0] as T;
}

/** Join the outer transaction when one is already open (libsql has no nested BEGIN). */
export function tx<T>(db: Db, fn: () => T): T {
  return db.inTransaction ? fn() : db.transaction(fn)();
}

export function openDb(path: string, options: DbOptions = {}): Db {
  const remote = Boolean(options.syncUrl);
  const db = remote
    ? new Database(path, {
        syncUrl: options.syncUrl,
        authToken: options.authToken,
        syncPeriod: options.syncPeriod ?? 30,
      } as unknown as Database.Options)
    : new Database(path);

  // Per connection, outside any transaction (CLAUDE.md database rules).
  db.pragma('foreign_keys = ON');
  if (!remote) db.pragma('journal_mode = WAL');
  // Pull the current remote state before deciding whether the schema is new.
  if (remote) db.sync();

  initSchema(db);
  applyMigrations(db);
  return db;
}

function initSchema(db: Db): void {
  const version = pragmaValue<number>(db, 'user_version');
  if (version > 0) return;
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  tx(db, () => {
    db.exec(schema); // schema.sql itself runs PRAGMA foreign_keys = ON; harmless here
    db.pragma('user_version = 2');
  });
}

function applyMigrations(db: Db): void {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const version = pragmaValue<number>(db, 'user_version');
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, n: Number(file.split('_')[0]) }))
    .filter(({ n }) => n > version);
  for (const { file, n } of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.pragma(`user_version = ${n}`);
    });
  }
}

/**
 * A staged copy of the database used while the model is deciding.
 * libsql does not implement better-sqlite3's serialize(), so use VACUUM INTO.
 */
export function stageDb(db: Db): { db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'xweek-stage-'));
  const path = join(dir, 'snapshot.db');
  try {
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const staged = new Database(path);
    staged.pragma('foreign_keys = ON');
    return {
      db: staged,
      close: () => {
        try {
          staged.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Test helper: in-memory database built from the real schema. */
export function openMemoryDb(): Db {
  return openDb(':memory:');
}
