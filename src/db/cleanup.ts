import type Database from 'better-sqlite3';

export type CleanupPhase = 'pending' | 'deleting' | 'adjustments' | 'budgets' | 'zeroed' | 'complete';

export interface CleanupState {
  cutoffDate: string;
  accountAdjustments: Record<string, number>;
  categoryCarryForwards: Record<string, number>;
  firstKeptBudgets: Record<string, number>;
  transactionIds: string[];
  earliestBudgetMonth: string;
  phase: CleanupPhase;
}

export function getIncompleteCleanup(db: Database.Database): CleanupState | null {
  const row = db.prepare(
    "SELECT * FROM cleanup_state WHERE phase != 'complete' ORDER BY created_at DESC LIMIT 1"
  ).get() as Record<string, string> | undefined;
  if (!row) return null;
  return deserialize(row);
}

export function insertCleanupState(db: Database.Database, state: CleanupState): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO cleanup_state
     (cutoff_date, account_adjustments, category_carry_forwards, first_kept_budgets, transaction_ids, earliest_budget_month, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    state.cutoffDate,
    JSON.stringify(state.accountAdjustments),
    JSON.stringify(state.categoryCarryForwards),
    JSON.stringify(state.firstKeptBudgets),
    JSON.stringify(state.transactionIds),
    state.earliestBudgetMonth,
    state.phase,
    now,
    now,
  );
}

export function updateCleanupPhase(db: Database.Database, cutoffDate: string, phase: CleanupPhase): void {
  db.prepare(
    "UPDATE cleanup_state SET phase = ?, updated_at = datetime('now') WHERE cutoff_date = ?"
  ).run(phase, cutoffDate);
}

export function deleteCleanupState(db: Database.Database, cutoffDate: string): void {
  db.prepare('DELETE FROM cleanup_state WHERE cutoff_date = ?').run(cutoffDate);
}

export function getMostRecentCompleted(db: Database.Database): CleanupState | null {
  const row = db.prepare(
    "SELECT * FROM cleanup_state WHERE phase = 'complete' ORDER BY updated_at DESC LIMIT 1"
  ).get() as Record<string, string> | undefined;
  if (!row) return null;
  return deserialize(row);
}

export function deleteOldCompletedStates(db: Database.Database): void {
  db.prepare(
    "DELETE FROM cleanup_state WHERE phase = 'complete' AND updated_at < datetime('now', '-30 days')"
  ).run();
}

function deserialize(row: Record<string, string>): CleanupState {
  return {
    cutoffDate: row['cutoff_date'],
    accountAdjustments: JSON.parse(row['account_adjustments']),
    categoryCarryForwards: JSON.parse(row['category_carry_forwards']),
    firstKeptBudgets: JSON.parse(row['first_kept_budgets']),
    transactionIds: JSON.parse(row['transaction_ids']),
    earliestBudgetMonth: row['earliest_budget_month'],
    phase: row['phase'] as CleanupPhase,
  };
}
