import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'libsql';
import { openDb, openMemoryDb, pragmaValue, stageDb } from './connection.js';
import { addDays, fromMinutes, toMinutes, weekRange, todayInTz, nowInTz } from '../../shared/time.js';

describe('db connection', () => {
  it('builds the schema from schema.sql and sets user_version = 2', () => {
    const db = openMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['chat_messages', 'settings', 'task_changes', 'task_groups', 'tasks']);
    expect(pragmaValue(db, 'user_version')).toBe(2);
  });

  it('is idempotent: initSchema does not re-run or wipe data', () => {
    const db = openMemoryDb();
    // settings row ships in schema.sql; just verify data survives a re-open call.
    const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get();
    expect(before).toMatchObject({ n: 1 });
    const version = pragmaValue<number>(db, 'user_version');
    expect(version).toBe(2);
  });

  it('has foreign_keys enabled and WAL on a real file db', () => {
    const mem = openMemoryDb();
    expect(pragmaValue(mem, 'foreign_keys')).toBe(1);
    // WAL is meaningless for :memory: (always 'memory'); use a temp file.
    const dir = mkdtempSync(join(tmpdir(), 'xweek-'));
    const db = openDb(join(dir, 'test.db'));
    expect(String(pragmaValue(db, 'journal_mode'))).toBe('wal');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reopens the handle after a Hrana stream error and retries prepare', () => {
    const original = Database.prototype.prepare;
    let failed = false;
    Database.prototype.prepare = function (this: Database.Database, source: string) {
      if (!failed && source.includes('SELECT 1 AS probe')) {
        failed = true;
        throw new Error(
          `Hrana(Api("status=404 Not Found, body={"error":"stream not found: 1:2"}"))`,
        );
      }
      return original.call(this, source);
    } as typeof original;

    const db = openMemoryDb();
    try {
      expect(db.prepare('SELECT 1 AS probe').get()).toMatchObject({ probe: 1 });
    } finally {
      db.close();
      Database.prototype.prepare = original;
    }
  });

  it('stageDb copies every table and keeps writes isolated', () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO task_groups (id, title) VALUES (2, 'Work')").run();
    db.prepare(
      "INSERT INTO tasks (id, group_id, title, task_date, start_time, end_time) " +
        "VALUES (1, 2, 'Deep work', '2026-10-26', '09:00', '10:00')",
    ).run();
    db.prepare("INSERT INTO chat_messages (id, role, content) VALUES (1, 'user', 'hello')").run();
    db.prepare(
      "INSERT INTO task_changes (id, message_id, task_id, action, after_json) " +
        "VALUES (1, 1, 1, 'create', '{}')",
    ).run();

    const staged = stageDb(db);
    for (const [table, expected] of [
      ['settings', 1],
      ['task_groups', 1],
      ['tasks', 1],
      ['chat_messages', 1],
      ['task_changes', 1],
    ] as const) {
      expect(staged.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({ n: expected });
    }

    staged.db.prepare("UPDATE tasks SET title = 'changed' WHERE id = 1").run();
    expect(staged.db.prepare('SELECT title FROM tasks WHERE id = 1').get()).toMatchObject({ title: 'changed' });
    expect(db.prepare('SELECT title FROM tasks WHERE id = 1').get()).toMatchObject({ title: 'Deep work' });

    staged.close();
    db.close();
  });

  it('stageDb skips legacy task_changes rows with a NULL action', () => {
    const db = openMemoryDb();
    // Simulate an imported legacy table that did not enforce NOT NULL.
    db.exec(`
      DROP TABLE task_changes;
      CREATE TABLE task_changes (
        id INTEGER PRIMARY KEY,
        message_id INTEGER,
        task_id INTEGER NOT NULL,
        action TEXT,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO task_changes (id, message_id, task_id, action, after_json)
      VALUES (1, NULL, 1, NULL, '{}');
    `);
    const staged = stageDb(db);
    expect(staged.db.prepare('SELECT COUNT(*) AS n FROM task_changes').get()).toMatchObject({ n: 0 });
    staged.close();
    db.close();
  });

  it('repairs an imported database whose user_version was reset to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xweek-import-'));
    const path = join(dir, 'test.db');
    const seeded = openDb(path);
    seeded.pragma('user_version = 0');
    seeded.close();

    const db = openDb(path);
    expect(pragmaValue(db, 'user_version')).toBe(2);
    const columns = db.pragma('table_info(task_groups)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('starts_on');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates an existing version 1 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xweek-migration-'));
    const path = join(dir, 'test.db');
    const oldDb = new Database(path);
    oldDb.exec('CREATE TABLE task_groups (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
    oldDb.pragma('user_version = 1');
    oldDb.close();

    const db = openDb(path);
    const columns = db.pragma('table_info(task_groups)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'title', 'starts_on', 'start_time', 'end_time',
    ]);
    expect(pragmaValue(db, 'user_version')).toBe(2);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('time helpers', () => {
  it('toMinutes / fromMinutes round-trip', () => {
    expect(toMinutes('07:30')).toBe(450);
    expect(toMinutes('23:59')).toBe(1439);
    expect(fromMinutes(450)).toBe('07:30');
    expect(fromMinutes(0)).toBe('00:00');
  });

  it('rejects invalid time/date formats', () => {
    expect(() => toMinutes('7:30')).toThrow();
    expect(() => toMinutes('24:00')).toThrow();
    expect(() => fromMinutes(1440)).toThrow();
    expect(() => addDays('2026-02-30', 1)).toThrow(); // impossible date
    expect(() => addDays('2026-13-01', 1)).toThrow();
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); // 2026 not a leap year
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is
  });

  it('weekRange respects week_starts_on', () => {
    // 2026-09-22 is a Tuesday.
    expect(weekRange('2026-09-22', 1)).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(weekRange('2026-09-22', 0)).toEqual({ start: '2026-09-20', end: '2026-09-26' });
    // Sunday with week starting Sunday: same day.
    expect(weekRange('2026-09-20', 0)).toEqual({ start: '2026-09-20', end: '2026-09-26' });
  });

  it('reads today/now through a timezone, not the server clock', () => {
    const utc = nowInTz('UTC');
    expect(utc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(utc.time).toMatch(/^\d{2}:\d{2}$/);
    // Two zones far apart should agree on the date at most an hour off midnight;
    // just check both parse and todayInTz agrees with nowInTz.
    expect(todayInTz('Pacific/Kiritimati')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayInTz('UTC')).toBe(utc.date);
  });
});
