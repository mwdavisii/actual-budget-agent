// tests/unit/actual/queries.maintenance.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRollingPruneCutoff, pruneTransactions, cleanupHiddenCategories, cleanupClosedAccounts } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

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
    },
  };
});

// ── getRollingPruneCutoff ────────────────────────────────────────────────────

describe('getRollingPruneCutoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a date string 24 months in the past', () => {
    vi.setSystemTime(new Date(2026, 2, 22)); // local time — avoids UTC-offset ambiguity
    expect(getRollingPruneCutoff(24)).toBe('2024-03-22');
  });

  it('clamps to last day of month when target month is shorter', () => {
    // March 31 minus 1 month = February 28 (not March 3)
    vi.setSystemTime(new Date(2026, 2, 31));
    expect(getRollingPruneCutoff(1)).toBe('2026-02-28');
  });

  it('handles leap year February correctly', () => {
    // March 31 2024 minus 1 month = February 29 2024 (leap year)
    vi.setSystemTime(new Date(2024, 2, 31));
    expect(getRollingPruneCutoff(1)).toBe('2024-02-29');
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
});

// ── pruneTransactions ────────────────────────────────────────────────────────

describe('pruneTransactions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry run returns count and sample without any deletions or budget changes', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-10', payee: 'Groceries', amount: -5000, category: 'cat-1' },
        { id: 'tx2', date: '2024-01-20', payee: 'Gas', amount: -3000, category: 'cat-2' },
      ],
    } as any);

    const result = await pruneTransactions('2024-02-01', true);

    expect(result.deleted).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(result.sample).toHaveLength(2);
    expect(actualApi.deleteTransaction).not.toHaveBeenCalled();
    expect(actualApi.setBudgetAmount).not.toHaveBeenCalled();
    expect(actualApi.getBudgetMonth).not.toHaveBeenCalled();
  });

  it('does nothing when there are no transactions before cutoff', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await pruneTransactions('2024-02-01', false);

    expect(result.deleted).toBe(0);
    expect(actualApi.deleteTransaction).not.toHaveBeenCalled();
    expect(actualApi.getBudgetMonth).not.toHaveBeenCalled();
    expect(actualApi.setBudgetAmount).not.toHaveBeenCalled();
  });

  it('applies carry-forward to firstKeptMonth when cutoff is the first of a month', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-10', payee: 'Dining', amount: -12000, category: 'cat-1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth)
      // lastZeroedMonth (2024-01): carry-forward per category
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 5000, budgeted: 10000 }] }],
      } as any)
      // firstKeptMonth (2024-02): existing budgets
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 0, budgeted: 10000 }] }],
      } as any);

    await pruneTransactions('2024-02-01', false);

    // Jan 2024 budget zeroed
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-01', 'cat-1', 0);
    // Feb 2024 gets existing budget (10000) + carry-forward (5000)
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-02', 'cat-1', 15000);
  });

  it('reduces carry-forward by deleted spend in firstKeptMonth for mid-month cutoffs', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-10', payee: 'Dining', amount: -12000, category: 'cat-1' },
        { id: 'tx2', date: '2024-02-05', payee: 'Dining', amount: -3000, category: 'cat-1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth)
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 5000, budgeted: 10000 }] }],
      } as any)
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 0, budgeted: 10000 }] }],
      } as any);

    await pruneTransactions('2024-02-15', false);

    // adjustment = carryForward (5000) + deletedInFeb (-3000) = 2000
    // Feb budget = 10000 + 2000 = 12000
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-02', 'cat-1', 12000);
  });

  it('skips carry-forward adjustment for income categories', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-15', payee: 'Salary', amount: 500000, category: 'inc-1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth)
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: true, categories: [{ id: 'inc-1', balance: 100000, budgeted: 100000 }] }],
      } as any)
      .mockResolvedValueOnce({
        categoryGroups: [{ is_income: true, categories: [{ id: 'inc-1', balance: 0, budgeted: 100000 }] }],
      } as any);

    await pruneTransactions('2024-02-01', false);

    // Jan zeroed for income too
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-01', 'inc-1', 0);
    // But carry-forward NOT applied to Feb for income
    expect(actualApi.setBudgetAmount).not.toHaveBeenCalledWith('2024-02', expect.anything(), expect.anything());
  });

  it('zeroes budget across the full month range from oldest deleted transaction', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2022-06-10', payee: 'Old', amount: -1000, category: 'cat-1' },
        { id: 'tx2', date: '2024-01-05', payee: 'Recent', amount: -2000, category: 'cat-1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 0, budgeted: 10000 }] }],
    } as any);

    await pruneTransactions('2024-02-01', false);

    // Earliest month and latest zeroed month both hit
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2022-06', 'cat-1', 0);
    expect(actualApi.setBudgetAmount).toHaveBeenCalledWith('2024-01', 'cat-1', 0);
    // 2022-06 through 2024-01 = 20 months
    const zeroCalls = vi.mocked(actualApi.setBudgetAmount).mock.calls.filter(
      ([, , amount]) => amount === 0
    );
    expect(zeroCalls).toHaveLength(20);
  });

  it('deletes all transactions before cutoff', async () => {
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { id: 'tx1', date: '2024-01-05', payee: 'A', amount: -1000, category: 'cat-1' },
        { id: 'tx2', date: '2024-01-20', payee: 'B', amount: -2000, category: 'cat-1' },
      ],
    } as any);
    vi.mocked(actualApi.getBudgetMonth).mockResolvedValue({
      categoryGroups: [{ is_income: false, categories: [{ id: 'cat-1', balance: 0, budgeted: 5000 }] }],
    } as any);

    await pruneTransactions('2024-02-01', false);

    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('tx1');
    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('tx2');
    expect(actualApi.deleteTransaction).toHaveBeenCalledTimes(2);
  });
});
