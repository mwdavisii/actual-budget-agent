import type Database from 'better-sqlite3';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS budget_targets (
    category_id   TEXT PRIMARY KEY,
    category_name TEXT NOT NULL,
    target_amount INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS cleanup_state (
    cutoff_date TEXT PRIMARY KEY,
    account_adjustments TEXT NOT NULL,
    category_carry_forwards TEXT NOT NULL,
    first_kept_budgets TEXT NOT NULL,
    transaction_ids TEXT NOT NULL,
    earliest_budget_month TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export function runMigrations(db: Database.Database): void {
  for (const sql of DDL_STATEMENTS) {
    try {
      db.prepare(sql).run();
    } catch (err: unknown) {
      // Current DDL is CREATE TABLE IF NOT EXISTS only, so this guard is
      // dormant. It's retained for forward-compatibility: when the deferred
      // cleanup suite is revived it may add ALTER TABLE migrations, which fail
      // with "duplicate column" on restart once already applied.
      const msg = err instanceof Error ? err.message : String(err);
      if (sql.startsWith('ALTER TABLE') && msg.includes('duplicate column')) {
        continue;
      }
      throw err;
    }
  }
}
