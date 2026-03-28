// tests/unit/actual/queries.maintenance.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRollingPruneCutoff, pruneTransactions, cleanupHiddenCategories, cleanupClosedAccounts } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import { getIncompleteCleanup } from '../../../src/db/cleanup';

vi.mock('../../../src/actual/client', () => {
  const mockChain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  return {
    actualApi: {
      getCategoryGroups: vi.fn(),
      getAccounts: vi.fn(),
      runQuery: vi.fn(),
      q: vi.fn(() => mockChain),
      deleteCategory: vi.fn(),
      deleteCategoryGroup: vi.fn(),
      deleteAccount: vi.fn(),
      deleteTransaction: vi.fn(),
      getBudgetMonth: vi.fn(),
      setBudgetAmount: vi.fn(),
      addTransactions: vi.fn(),
    },
  };
});

vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// ── getRollingPruneCutoff ────────────────────────────────────────────────────

describe('getRollingPruneCutoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the 1st of the month N months ago', () => {
    vi.setSystemTime(new Date(2026, 2, 25)); // March 25, 2026
    expect(getRollingPruneCutoff(24)).toBe('2024-04-01');
  });

  it('snaps to 1st even on the 1st', () => {
    vi.setSystemTime(new Date(2026, 2, 1)); // March 1, 2026
    expect(getRollingPruneCutoff(24)).toBe('2024-04-01');
  });

  it('handles year boundary', () => {
    vi.setSystemTime(new Date(2026, 0, 15)); // Jan 15, 2026
    expect(getRollingPruneCutoff(3)).toBe('2025-11-01');
  });
});

// ── cleanupHiddenCategories ──────────────────────────────────────────────────

describe('cleanupHiddenCategories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry run returns names without deleting', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Old Group', hidden: false,
        categories: [{ id: 'c1', name: 'Old Stuff', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupHiddenCategories(true);

    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Old Stuff');
    expect(result.warnings).toHaveLength(0);
    expect(actualApi.deleteCategory).not.toHaveBeenCalled();
  });

  it('deletes hidden category with 0 transactions when not dry run', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Active Group', hidden: false,
        categories: [{ id: 'c1', name: 'Empty Hidden', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategory).toHaveBeenCalledWith('c1');
    expect(result.deleted).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('skips hidden category that still has transactions', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Group', hidden: false,
        categories: [{ id: 'c1', name: 'Has Txns', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [{ id: 'tx1' }] } as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategory).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('deletes a hidden group that is already empty (no categories)', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { id: 'g1', name: 'Ghost Group', hidden: true, categories: [] },
    ] as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategoryGroup).toHaveBeenCalledWith('g1');
    expect(result.warnings).toHaveLength(0);
    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Ghost Group');
  });

  it('records warning and continues when a delete fails', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Group', hidden: false,
        categories: [
          { id: 'c1', name: 'Will Fail', hidden: true },
          { id: 'c2', name: 'Will Succeed', hidden: true },
        ],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.deleteCategory)
      .mockRejectedValueOnce(new Error('DB locked'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupHiddenCategories(false);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Will Fail');
    expect(result.deleted).toBe(1);
  });

  it('passes cutoff date filter when provided', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Group', hidden: false,
        categories: [{ id: 'c1', name: 'Old Hidden', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    await cleanupHiddenCategories(true, '2024-03-01');

    const chain = vi.mocked(actualApi.q).mock.results[0].value;
    expect(chain.filter).toHaveBeenCalledWith(
      expect.objectContaining({ date: { $gte: '2024-03-01' } })
    );
  });
});

// ── cleanupClosedAccounts ────────────────────────────────────────────────────

describe('cleanupClosedAccounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry run returns names without deleting', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Old Checking', closed: true },
      { id: 'a2', name: 'Active Checking', closed: false },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupClosedAccounts(true);

    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Old Checking');
    expect(actualApi.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes closed account with 0 transactions', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Empty Closed', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupClosedAccounts(false);

    expect(actualApi.deleteAccount).toHaveBeenCalledWith('a1');
    expect(result.deleted).toBe(1);
  });

  it('skips closed account that has transactions', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Has History', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [{ id: 'tx1' }] } as any);

    const result = await cleanupClosedAccounts(false);

    expect(actualApi.deleteAccount).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('records warning and continues on delete failure', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Will Fail', closed: true },
      { id: 'a2', name: 'Will Succeed', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.deleteAccount)
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupClosedAccounts(false);

    expect(result.warnings).toHaveLength(1);
    expect(result.deleted).toBe(1);
  });

  it('passes cutoff date filter when provided', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Old Closed', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    await cleanupClosedAccounts(true, '2024-03-01');

    const chain = vi.mocked(actualApi.q).mock.results[0].value;
    expect(chain.filter).toHaveBeenCalledWith(
      expect.objectContaining({ date: { $gte: '2024-03-01' } })
    );
  });
});

// ── pruneTransactions — phased ───────────────────────────────────────────────

describe('pruneTransactions — phased', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Phase 0: persists snapshot to cleanup_state', async () => {
    const db = makeDb();

    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-15', payee: 'Store', amount: -5000, category: 'cat1', account: 'acc1' },
        { id: 'tx2', date: '2024-02-10', payee: 'Gas', amount: -3000, category: 'cat2', account: 'acc1' },
      ],
    } as any);

    vi.mocked(actualApi.getBudgetMonth).mockImplementation(async (month: string) => {
      if (month === '2024-03') {
        return {
          categoryGroups: [
            { is_income: false, categories: [
              { id: 'cat1', balance: 50000, budgeted: 10000 },
              { id: 'cat2', balance: 20000, budgeted: 5000 },
            ]},
            { is_income: true, categories: [
              { id: 'income1', balance: 0, budgeted: 0 },
            ]},
          ],
        } as any;
      }
      if (month === '2024-04') {
        return {
          categoryGroups: [
            { is_income: false, categories: [
              { id: 'cat1', budgeted: 12000 },
              { id: 'cat2', budgeted: 6000 },
            ]},
            { is_income: true, categories: [
              { id: 'income1', budgeted: 0 },
            ]},
          ],
        } as any;
      }
      return { categoryGroups: [] } as any;
    });

    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'acc1', name: 'Checking', closed: false, offbudget: false },
    ] as any);

    await pruneTransactions('2024-04-01', false, db);

    // Phases run to completion (stubs are no-ops), so query the raw row
    const row = db.prepare('SELECT * FROM cleanup_state WHERE cutoff_date = ?').get('2024-04-01') as Record<string, string> | undefined;
    expect(row).toBeDefined();
    expect(row!['cutoff_date']).toBe('2024-04-01');
    expect(JSON.parse(row!['transaction_ids'])).toEqual(['tx1', 'tx2']);
    expect(JSON.parse(row!['account_adjustments'])).toEqual({ acc1: -8000 });
    expect(JSON.parse(row!['category_carry_forwards'])).toEqual({ cat1: 50000, cat2: 20000 });
    expect(JSON.parse(row!['first_kept_budgets'])).toEqual({ cat1: 12000, cat2: 6000, income1: 0 });
    expect(row!['earliest_budget_month']).toBe('2024-01');
    // Verify phase completed
    expect(row!['phase']).toBe('complete');
  });

  it('Phase 1: deletes transactions and handles not-found gracefully', async () => {
    const db = makeDb();
    const { insertCleanupState } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: { acc1: -5000 },
      categoryCarryForwards: { cat1: 50000 },
      firstKeptBudgets: { cat1: 12000 },
      transactionIds: ['tx1', 'tx2', 'tx3'],
      earliestBudgetMonth: '2022-01',
      phase: 'pending',
    });

    vi.mocked(actualApi.deleteTransaction)
      .mockResolvedValueOnce(undefined as any)
      .mockRejectedValueOnce(new Error('transaction not found'))
      .mockResolvedValueOnce(undefined as any);

    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-15', payee: 'Store', amount: -5000, category: 'cat1', account: 'acc1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [
        { is_income: true, categories: [{ id: 'income1', name: 'Income' }] },
      ],
    } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);

    await pruneTransactions('2024-04-01', false, db);

    expect(actualApi.deleteTransaction).toHaveBeenCalledTimes(3);
    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('tx1');
    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('tx2');
    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('tx3');
  });

  it('Phase 2: creates adjustment transactions per account, skips existing', async () => {
    const db = makeDb();
    const { insertCleanupState, updateCleanupPhase } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: { acc1: -8000, acc2: 15000 },
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'deleting',
    });
    updateCleanupPhase(db, '2024-04-01', 'adjustments');

    // Mock runQuery: argument-based dispatch to avoid fragile ordering
    let runQueryCallCount = 0;
    vi.mocked(actualApi.runQuery).mockImplementation(async () => {
      runQueryCallCount++;
      if (runQueryCallCount === 1) return { data: [] } as any; // initial transaction query (0 rows)
      if (runQueryCallCount === 2) return { data: [] } as any; // acc1 check — not found
      if (runQueryCallCount === 3) return { data: [{ id: 'existing' }] } as any; // acc2 check — already exists
      return { data: [] } as any;
    });

    vi.mocked(actualApi.addTransactions).mockResolvedValue([] as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [
        { is_income: true, categories: [{ id: 'income1', name: 'Income' }] },
        { is_income: false, categories: [{ id: 'cat1' }, { id: 'cat2' }] },
      ],
    } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);

    await pruneTransactions('2024-04-01', false, db);

    // Only acc1 should get a new transaction (acc2 already exists)
    expect(actualApi.addTransactions).toHaveBeenCalledTimes(1);
    expect(actualApi.addTransactions).toHaveBeenCalledWith('acc1', [
      expect.objectContaining({
        date: '2024-04-01',
        amount: -8000,
        payee_name: 'Prior Balance',
        notes: expect.stringContaining('cleanup:2024-04-01:acc1'),
        category: 'income1',
      }),
    ]);
  });

  it('Phase 3: sets firstKeptMonth budget = existing + carry-forward', async () => {
    const db = makeDb();
    const { insertCleanupState, updateCleanupPhase } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: { cat1: 50000, cat2: -3000 },
      firstKeptBudgets: { cat1: 12000, cat2: 6000 },
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'budgets',
    });

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({ categoryGroups: [] } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);

    await pruneTransactions('2024-04-01', false, db);

    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-04', 'cat1', 62000); // 12000 + 50000
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-04', 'cat2', 3000);  // 6000 + (-3000)
  });

  it('Phase 4: zeros only non-zero budget entries', async () => {
    const db = makeDb();
    const { insertCleanupState } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2024-01',
      phase: 'zeroed',
    });

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);

    // 3 months to zero: 2024-01, 2024-02, 2024-03
    vi.mocked(actualApi.getBudgetMonth).mockImplementation(async (month: string) => {
      if (month === '2024-01') return {
        categoryGroups: [{ categories: [{ id: 'cat1', budgeted: 10000 }, { id: 'cat2', budgeted: 0 }] }],
      } as any;
      if (month === '2024-02') return {
        categoryGroups: [{ categories: [{ id: 'cat1', budgeted: 0 }, { id: 'cat2', budgeted: 5000 }] }],
      } as any;
      if (month === '2024-03') return {
        categoryGroups: [{ categories: [{ id: 'cat1', budgeted: 10000 }, { id: 'cat2', budgeted: 5000 }] }],
      } as any;
      return { categoryGroups: [] } as any;
    });

    await pruneTransactions('2024-04-01', false, db);

    // cat2 in 2024-01 is already 0 → skipped. Only 4 calls, not 6.
    expect(actualApi.setBudgetAmount).toHaveBeenCalledTimes(4);
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-01', 'cat1', 0);
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-02', 'cat2', 0);
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-03', 'cat1', 0);
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-03', 'cat2', 0);
  });

  it('resumes from interrupted phase (skips completed phases)', async () => {
    const db = makeDb();
    const { insertCleanupState } = await import('../../../src/db/cleanup');

    // State stuck at 'adjustments' — Phases 0 and 1 (delete) already done
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: { acc1: -5000 },
      categoryCarryForwards: { cat1: 50000 },
      firstKeptBudgets: { cat1: 12000 },
      transactionIds: ['tx1'],
      earliestBudgetMonth: '2024-01',
      phase: 'adjustments',
    });

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.addTransactions).mockResolvedValue([] as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [
        { is_income: true, categories: [{ id: 'income1', name: 'Income' }] },
      ],
    } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);

    await pruneTransactions('2024-04-01', false, db);

    // deleteTransaction should NOT be called — Phase 1 was already done
    expect(actualApi.deleteTransaction).not.toHaveBeenCalled();
    // But Phase 2 (adjustments) should run
    expect(actualApi.addTransactions).toHaveBeenCalled();
  });

  it('rejects mismatched cutoff when incomplete cleanup exists', async () => {
    const db = makeDb();
    const { insertCleanupState } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'deleting',
    });

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [{ id: 'tx1', date: '2024-01-01', payee: 'X', amount: -100, category: 'c1', account: 'a1' }] } as any);

    await expect(pruneTransactions('2025-01-01', false, db)).rejects.toThrow(/incomplete/);
  });

  it('clear_state abandons incomplete cleanup and starts fresh', async () => {
    const db = makeDb();
    const { insertCleanupState, getIncompleteCleanup } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: [],
      earliestBudgetMonth: '2022-01',
      phase: 'deleting',
    });

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({ categoryGroups: [] } as any);

    // Clear state and run with different cutoff — no error
    await pruneTransactions('2025-01-01', false, db, true);

    // Old state should be gone
    const state = getIncompleteCleanup(db);
    expect(state === null || state.cutoffDate === '2025-01-01').toBe(true);
  });

  it('clear_state rejects when partial deletion detected', async () => {
    const db = makeDb();
    const { insertCleanupState } = await import('../../../src/db/cleanup');
    insertCleanupState(db, {
      cutoffDate: '2024-04-01',
      accountAdjustments: {},
      categoryCarryForwards: {},
      firstKeptBudgets: {},
      transactionIds: ['tx1', 'tx2', 'tx3', 'tx4', 'tx5'], // snapshot had 5
      earliestBudgetMonth: '2022-01',
      phase: 'deleting',
    });

    // Only 3 transactions remain (2 were deleted before clear_state)
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx3', date: '2024-01-01', payee: 'X', amount: -100, category: 'c1', account: 'a1' },
        { id: 'tx4', date: '2024-01-02', payee: 'Y', amount: -200, category: 'c1', account: 'a1' },
        { id: 'tx5', date: '2024-01-03', payee: 'Z', amount: -300, category: 'c1', account: 'a1' },
      ],
    } as any);

    await expect(pruneTransactions('2024-04-01', false, db, true)).rejects.toThrow(/2 transactions were already deleted/);
  });

  it('Phase 0: excludes off-budget transactions from account_adjustments but includes in transactionIds', async () => {
    const db = makeDb();

    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-15', payee: 'Store', amount: -5000, category: 'cat1', account: 'acc1' },
        { id: 'tx-offbudget', date: '2024-02-10', payee: 'Home Value', amount: 100000, category: null, account: 'acc-offbudget' },
      ],
    } as any);

    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [
        { is_income: true, categories: [{ id: 'income1', name: 'Income', balance: 0, budgeted: 0 }] },
        { is_income: false, categories: [{ id: 'cat1', balance: 50000, budgeted: 10000 }] },
      ],
    } as any);

    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'acc1', name: 'Checking', closed: false, offbudget: false },
      { id: 'acc-offbudget', name: 'Home Equity', closed: false, offbudget: true },
    ] as any);

    await pruneTransactions('2024-04-01', false, db);

    // Query raw DB since phases run to completion
    const row = db.prepare('SELECT * FROM cleanup_state WHERE cutoff_date = ?').get('2024-04-01') as Record<string, string>;
    expect(JSON.parse(row['transaction_ids'])).toEqual(['tx1', 'tx-offbudget']); // both included
    expect(JSON.parse(row['account_adjustments'])).toEqual({ acc1: -5000 }); // off-budget excluded
  });

  it('full cleanup is idempotent — running twice with same cutoff returns without error', async () => {
    const db = makeDb();

    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.getAccounts).mockResolvedValue([] as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({ categoryGroups: [] } as any);

    // First run: no transactions, no incomplete state — returns early
    const result1 = await pruneTransactions('2024-04-01', false, db);
    expect(result1.deleted).toBe(0);

    // Second run: same thing — no error
    const result2 = await pruneTransactions('2024-04-01', false, db);
    expect(result2.deleted).toBe(0);
  });

  it('dry run returns preview without persisting state', async () => {
    const db = makeDb();
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-15', payee: 'Store', amount: -5000, category: 'cat1', account: 'acc1' },
      ],
    } as any);

    const result = await pruneTransactions('2024-04-01', true, db);

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(1);
    expect(getIncompleteCleanup(db)).toBeNull();
  });
});
