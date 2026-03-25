import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import {
  getIncompleteCleanup,
  insertCleanupState,
  updateCleanupPhase,
  deleteCleanupState,
  deleteOldCompletedStates,
  type CleanupState,
} from '../../../src/db/cleanup';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('cleanup state helpers', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('insertCleanupState persists a row and getIncompleteCleanup retrieves it', () => {
    const state: CleanupState = {
      cutoffDate: '2024-04-01',
      accountAdjustments: { acc1: 5000 },
      categoryCarryForwards: { cat1: 3000 },
      firstKeptBudgets: { cat1: 1200 },
      transactionIds: ['tx1', 'tx2'],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    };
    insertCleanupState(db, state);
    const result = getIncompleteCleanup(db);
    expect(result).not.toBeNull();
    expect(result!.cutoffDate).toBe('2024-04-01');
    expect(result!.accountAdjustments).toEqual({ acc1: 5000 });
    expect(result!.transactionIds).toEqual(['tx1', 'tx2']);
  });

  it('getIncompleteCleanup returns null when no incomplete rows', () => {
    expect(getIncompleteCleanup(db)).toBeNull();
  });

  it('getIncompleteCleanup returns null when all rows are complete', () => {
    const state: CleanupState = {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    };
    insertCleanupState(db, state);
    updateCleanupPhase(db, '2024-04-01', 'complete');
    expect(getIncompleteCleanup(db)).toBeNull();
  });

  it('updateCleanupPhase updates phase and updated_at', () => {
    const state: CleanupState = {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    };
    insertCleanupState(db, state);
    updateCleanupPhase(db, '2024-04-01', 'deleting');
    const result = getIncompleteCleanup(db);
    expect(result!.phase).toBe('deleting');
  });

  it('deleteCleanupState removes the row', () => {
    const state: CleanupState = {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    };
    insertCleanupState(db, state);
    deleteCleanupState(db, '2024-04-01');
    expect(getIncompleteCleanup(db)).toBeNull();
  });

  it('deleteOldCompletedStates removes completed rows older than 30 days', () => {
    const state: CleanupState = {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    };
    insertCleanupState(db, state);
    // Manually set to complete with old timestamp
    db.prepare("UPDATE cleanup_state SET phase = 'complete', updated_at = datetime('now', '-31 days') WHERE cutoff_date = ?").run('2024-04-01');
    deleteOldCompletedStates(db);
    const rows = db.prepare('SELECT * FROM cleanup_state').all();
    expect(rows).toHaveLength(0);
  });
});
