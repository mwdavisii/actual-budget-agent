import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import {
  seedTargets,
  getTargets,
  setTarget,
  getUnderfundedCategories,
} from '../../../src/db/targets';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

const mockCategories = [
  { id: 'cat1', name: 'Groceries', budgeted: 50000, spent: 30000, available: 20000, isIncome: false },
  { id: 'cat2', name: 'Dining Out', budgeted: 20000, spent: 15000, available: 5000, isIncome: false },
  { id: 'cat3', name: 'Income', budgeted: 0, spent: 0, available: 0, isIncome: true },
];

describe('seedTargets', () => {
  it('seeds targets from category data, excluding income', () => {
    const db = makeDb();
    const count = seedTargets(db, mockCategories);
    expect(count).toBe(2);
    const targets = getTargets(db);
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.categoryId === 'cat1')?.targetAmount).toBe(50000);
    expect(targets.find((t) => t.categoryId === 'cat3')).toBeUndefined();
  });

  it('overwrites existing targets on re-seed', () => {
    const db = makeDb();
    seedTargets(db, mockCategories);
    const updated = [{ ...mockCategories[0], budgeted: 60000 }, mockCategories[1], mockCategories[2]];
    seedTargets(db, updated);
    const targets = getTargets(db);
    expect(targets.find((t) => t.categoryId === 'cat1')?.targetAmount).toBe(60000);
  });

  it('skips categories with zero budget', () => {
    const db = makeDb();
    seedTargets(db, mockCategories);
    expect(getTargets(db)).toHaveLength(2);
  });
});

describe('setTarget', () => {
  it('sets a target by category ID', () => {
    const db = makeDb();
    setTarget(db, 'cat1', 'Groceries', 55000);
    const targets = getTargets(db);
    expect(targets).toHaveLength(1);
    expect(targets[0].targetAmount).toBe(55000);
  });

  it('overwrites existing target', () => {
    const db = makeDb();
    setTarget(db, 'cat1', 'Groceries', 50000);
    setTarget(db, 'cat1', 'Groceries', 60000);
    expect(getTargets(db)).toHaveLength(1);
    expect(getTargets(db)[0].targetAmount).toBe(60000);
  });
});

describe('getUnderfundedCategories', () => {
  it('returns categories where budgeted < target', () => {
    const db = makeDb();
    setTarget(db, 'cat1', 'Groceries', 50000);
    setTarget(db, 'cat2', 'Dining Out', 20000);
    const liveCategories = [
      { id: 'cat1', name: 'Groceries', budgeted: 35000, spent: 0, available: 35000, isIncome: false },
      { id: 'cat2', name: 'Dining Out', budgeted: 20000, spent: 0, available: 20000, isIncome: false },
    ];
    const underfunded = getUnderfundedCategories(db, liveCategories);
    expect(underfunded).toHaveLength(1);
    expect(underfunded[0].categoryName).toBe('Groceries');
    expect(underfunded[0].gap).toBe(15000);
  });

  it('uses live category name for renames', () => {
    const db = makeDb();
    setTarget(db, 'cat1', 'Old Name', 50000);
    const liveCategories = [
      { id: 'cat1', name: 'New Name', budgeted: 30000, spent: 0, available: 30000, isIncome: false },
    ];
    const underfunded = getUnderfundedCategories(db, liveCategories);
    expect(underfunded[0].categoryName).toBe('New Name');
  });

  it('skips orphaned targets with no live match', () => {
    const db = makeDb();
    setTarget(db, 'cat-deleted', 'Gone', 50000);
    const underfunded = getUnderfundedCategories(db, []);
    expect(underfunded).toHaveLength(0);
  });

  it('skips targets with amount 0', () => {
    const db = makeDb();
    setTarget(db, 'cat1', 'Groceries', 0);
    const liveCategories = [
      { id: 'cat1', name: 'Groceries', budgeted: 0, spent: 0, available: 0, isIncome: false },
    ];
    expect(getUnderfundedCategories(db, liveCategories)).toHaveLength(0);
  });
});
