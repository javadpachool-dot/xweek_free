import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

export const DB_RECONNECT = Symbol('xweek.reconnect');
type ReconnectableDb = Db & { [DB_RECONNECT]?: () => void };

function isStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stream not found|STREAM_EXPIRED|stream has expired|HRANA_CLOSED/i.test(message);
}

function reconnectDb(db: Db): void {
  const reconnect = (db as ReconnectableDb)[DB_RECONNECT];
  if (typeof reconnect !== 'function') throw new Error('Database cannot reconnect');
  reconnect();
}

/** Join the outer transaction when one is already open (libsql has no nested BEGIN). */
export function tx<T>(db: Db, fn: () => T): T {
  const run = () => (db.inTransaction ? fn() : db.transaction(fn)());
  try {
    return run();
  } catch (error) {
    if (!isStreamError(error) || db.inTransaction) throw error;
    reconnectDb(db);
    return run();
  }
}

/**
 * A short read before a write-only transaction keeps the Hrana stream warm.
 * Turso closes idle streams while the model is thinking; reconnecting here
 * avoids a `stream not found` failure on the final commit.
 */
export function warmDb(db: Db): void {
  const run = () => {
    db.prepare('SELECT 1 AS ok').get();
  };
  try {
    run();
  } catch (error) {
    if (!isStreamError(error)) throw error;
    reconnectDb(db);
    run();
  }
}

function openNativeDb(path: string, options: DbOptions = {}): Db {
  const remote = Boolean(options.syncUrl);
  const db = remote
    ? new Database(path, {
        syncUrl: options.syncUrl,
        authToken: options.authToken,
        syncPeriod: options.syncPeriod ?? 30,
      } as unknown as Database.Options)
    : new Database(path);

  // Per connection, outside any transaction (CLAUDE.md database rules).
  try {
    db.pragma('foreign_keys = ON');
  } catch (error) {
    // Some hosted libSQL endpoints reject connection pragmas; FK defaults apply.
    if (!remote) throw error;
  }
  if (!remote) db.pragma('journal_mode = WAL');
  // Pull the current remote state before deciding whether the schema is new.
  if (remote) db.sync();

  initSchema(db, remote);
  applyMigrations(db, remote);
  return db;
}

/**
 * Turso closes idle Hrana streams server-side. libsql does not reconnect
 * automatically, so reopen the native handle and retry a failed prepare once.
 */
export function openDb(path: string, options: DbOptions = {}): Db {
  const state = {
    inner: openNativeDb(path, options),
    path,
    options,
    closed: false,
  };

  const reconnect = () => {
    if (state.closed) throw new Error('Database is closed');
    try {
      state.inner.close();
    } catch {
      // The old handle is already unusable; open a fresh one.
    }
    state.inner = openNativeDb(path, options);
  };

  return new Proxy({} as Db, {
    get(_target, property) {
      if (property === 'inTransaction') return state.inner.inTransaction;
      if (property === DB_RECONNECT) return reconnect;
      if (property === 'prepare') {
        return (source: string) => {
          try {
            return state.inner.prepare(source);
          } catch (error) {
            if (!isStreamError(error) || state.inner.inTransaction) throw error;
            reconnect();
            return state.inner.prepare(source);
          }
        };
      }
      if (property === 'close') {
        return () => {
          state.closed = true;
          return state.inner.close();
        };
      }
      const value = Reflect.get(state.inner, property, state.inner);
      return typeof value === 'function' ? value.bind(state.inner) : value;
    },
  });
}

/**
 * Remote Turso rejects `PRAGMA user_version = N` (SQL_PARSE_ERROR), so remote
 * databases keep the schema version in a small table instead.
 */
function getSchemaVersion(db: Db, remote: boolean): number {
  if (!remote) return pragmaValue<number>(db, 'user_version');
  const exists = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
  ).get();
  if (!exists) return 0;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function setSchemaVersion(db: Db, remote: boolean, version: number): void {
  if (!remote) {
    db.pragma(`user_version = ${version}`);
    return;
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(String(version));
}

function initSchema(db: Db, remote: boolean): void {
  const version = getSchemaVersion(db, remote);
  if (version > 0) return;
  // An imported Turso database can already have the tables while the version is 0.
  const existing = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
  ).get();
  if (existing) {
    // A database imported with `turso db create --from-file` may have lost its
    // user_version. Infer the migration state from the task_groups columns.
    const groups = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_groups'",
    ).get() as { sql: string } | undefined;
    const version = groups && /\bstarts_on\b/.test(groups.sql) ? 2 : 1;
    tx(db, () => setSchemaVersion(db, remote, version));
    return;
  }
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  tx(db, () => {
    db.exec(schema); // schema.sql itself runs PRAGMA foreign_keys = ON; harmless here
    setSchemaVersion(db, remote, 2);
  });
}

function applyMigrations(db: Db, remote: boolean): void {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const version = getSchemaVersion(db, remote);
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, n: Number(file.split('_')[0]) }))
    .filter(({ n }) => n > version);
  for (const { file, n } of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    tx(db, () => {
      db.exec(sql);
      setSchemaVersion(db, remote, n);
    });
  }
}

/**
 * A staged in-memory copy of the database used while the model is deciding.
 * Turso rejects VACUUM/serialize/backup, so copy the small xWeek tables with
 * ordinary SELECT/INSERT statements instead.
 */
export function stageDb(db: Db): { db: Db; close: () => void } {
  const staged = new Database(':memory:');
  staged.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  staged.pragma('foreign_keys = OFF');

  const tables = staged
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  for (const { name } of tables) {
    staged.prepare(`DELETE FROM "${name}"`).run();
  }

  for (const { name } of tables) {
    const columns = (staged.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (columns.length === 0) continue;
    const quoted = columns.map((column) => `"${column}"`).join(', ');
    const rows = db.prepare(`SELECT ${quoted} FROM "${name}"`).all() as Array<Record<string, unknown>>;
    const insert = staged.prepare(
      `INSERT INTO "${name}" (${quoted}) VALUES (${columns.map(() => '?').join(', ')})`,
    );
    for (const row of rows) {
      try {
        insert.run(...columns.map((column) => row[column]));
      } catch (error) {
        // Old imports can contain audit rows whose `action` is NULL. They are
        // not needed to plan, and must not make the whole staged copy fail.
        if (name !== 'task_changes') throw error;
        console.warn('Skipping an invalid task_changes row:', row.id, error);
      }
    }
  }

  staged.pragma('foreign_keys = ON');
  staged.pragma('user_version = 2');
  return { db: staged, close: () => staged.close() };
}

/** Test helper: in-memory database built from the real schema. */
export function openMemoryDb(): Db {
  return openDb(':memory:');
}
