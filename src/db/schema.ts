import type Database from 'better-sqlite3';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    thread_id   TEXT PRIMARY KEY,
    messages    TEXT NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS archived_sessions (
    thread_id   TEXT PRIMARY KEY,
    messages    TEXT NOT NULL,
    archived_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS pending_proposals (
    id           TEXT PRIMARY KEY,
    tx_id        TEXT NOT NULL,
    category     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    thread_id    TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS budget_targets (
    category_id   TEXT PRIMARY KEY,
    category_name TEXT NOT NULL,
    target_amount INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
];

export function runMigrations(db: Database.Database): void {
  for (const sql of DDL_STATEMENTS) {
    db.prepare(sql).run();
  }
}
