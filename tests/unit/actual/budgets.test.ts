import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setBudgetsByMode } from '../../../src/actual/budgets';
import { actualApi } from '../../../src/actual/client';
import { resolveCategory } from '../../../src/actual/naming';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getCategoryGroups: vi.fn(),
    getBudgetMonth: vi.fn(),
    setBudgetAmount: vi.fn(),
    batchBudgetUpdates: vi.fn((fn: () => Promise<void>) => fn()),
  },
}));

vi.mock('../../../src/actual/naming', () => ({
  resolveCategory: vi.fn(),
}));

const GROUPS = [
  {
    id: 'g1',
    name: 'Everyday',
    hidden: false,
    is_income: false,
    categories: [
      { id: 'c1', name: 'Groceries', hidden: false, is_income: false },
      { id: 'c2', name: 'Dining', hidden: false, is_income: false },
    ],
  },
  {
    id: 'gi',
    name: 'Income',
    hidden: false,
    is_income: true,
    categories: [{ id: 'i1', name: 'Paycheck', hidden: false, is_income: true }],
  },
  {
    id: 'gh',
    name: 'Archived',
    hidden: true,
    is_income: false,
    categories: [{ id: 'c3', name: 'Secret', hidden: false }],
  },
  {
    id: 'g2',
    name: 'Hidden categories',
    hidden: false,
    is_income: false,
    categories: [{ id: 'c4', name: 'Old', hidden: true }],
  },
];

const MONTHS: Record<string, unknown> = {
  '2026-06': {
    categoryGroups: [
      {
        is_income: false,
        categories: [
          { id: 'c1', name: 'Groceries', budgeted: 1000 },
          { id: 'c2', name: 'Dining', budgeted: 200 },
          { id: 'c3', name: 'Secret', budgeted: 999 },
        ],
      },
      {
        is_income: true,
        categories: [{ id: 'i1', name: 'Paycheck', budgeted: 5000 }],
      },
    ],
  },
  '2026-05': {
    categoryGroups: [
      {
        is_income: false,
        categories: [
          { id: 'c1', name: 'Groceries', budgeted: 2000 },
          { id: 'c2', name: 'Dining', budgeted: 300 },
        ],
      },
      {
        is_income: true,
        categories: [{ id: 'i1', name: 'Paycheck', budgeted: 100 }],
      },
    ],
  },
  '2026-04': {
    categoryGroups: [
      {
        is_income: false,
        categories: [{ id: 'c1', name: 'Groceries', budgeted: 3000 }],
      },
    ],
  },
  '2026-03': {
    categoryGroups: [
      {
        is_income: false,
        categories: [
          { id: 'c1', name: 'Groceries', budgeted: 4000 },
          { id: 'c2', name: 'Dining', budgeted: 600 },
        ],
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (actualApi.getCategoryGroups as any).mockResolvedValue(GROUPS);
  (actualApi.getBudgetMonth as any).mockImplementation((month: string) =>
    Promise.resolve(MONTHS[month] ?? { categoryGroups: [] })
  );
  (actualApi.setBudgetAmount as any).mockResolvedValue(undefined);
  (actualApi.batchBudgetUpdates as any).mockImplementation((fn: () => Promise<void>) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setBudgetsByMode', () => {
  it('copy_last_month projects the previous month and excludes hidden/income categories', async () => {
    const result = await setBudgetsByMode({ month: '2026-06', mode: 'copy_last_month' });

    expect(result).toEqual({
      dryRun: true,
      month: '2026-06',
      mode: 'copy_last_month',
      includeIncome: false,
      categoryCount: 2,
      categories: [
        { id: 'c1', name: 'Groceries', isIncome: false, oldBudgeted: 1000, newBudgeted: 2000 },
        { id: 'c2', name: 'Dining', isIncome: false, oldBudgeted: 200, newBudgeted: 300 },
      ],
    });
    expect(actualApi.setBudgetAmount).not.toHaveBeenCalled();
    expect(actualApi.batchBudgetUpdates).not.toHaveBeenCalled();
  });

  it('three_month_average averages the previous 3 months and rounds to the nearest cent', async () => {
    const result = await setBudgetsByMode({ month: '2026-06', mode: 'three_month_average' });

    // c1: (2000 + 3000 + 4000) / 3 = 3000. c2: (300 + 0 + 600) / 3 = 300.
    expect(result.categories).toEqual([
      { id: 'c1', name: 'Groceries', isIncome: false, oldBudgeted: 1000, newBudgeted: 3000 },
      { id: 'c2', name: 'Dining', isIncome: false, oldBudgeted: 200, newBudgeted: 300 },
    ]);
  });

  it('three_month_average rounds a fractional average', async () => {
    (actualApi.getBudgetMonth as any).mockImplementation((month: string) => {
      const budgets: Record<string, number> = {
        '2026-06': 0,
        '2026-05': 100,
        '2026-04': 100,
        '2026-03': 102,
      };
      return Promise.resolve({
        categoryGroups: [
          { is_income: false, categories: [{ id: 'c1', name: 'Groceries', budgeted: budgets[month] }] },
        ],
      });
    });

    const result = await setBudgetsByMode({ month: '2026-06', mode: 'three_month_average' });

    // (100 + 100 + 102) / 3 = 100.67 → 101
    expect(result.categories[0]?.newBudgeted).toBe(101);
  });

  it('custom_amount sets every selected category to the given cents value', async () => {
    const result = await setBudgetsByMode({
      month: '2026-06',
      mode: 'custom_amount',
      amount: 12345,
    });

    expect(result.categories).toEqual([
      { id: 'c1', name: 'Groceries', isIncome: false, oldBudgeted: 1000, newBudgeted: 12345 },
      { id: 'c2', name: 'Dining', isIncome: false, oldBudgeted: 200, newBudgeted: 12345 },
    ]);
  });

  it('writes through batchBudgetUpdates only when dryRun is false', async () => {
    const result = await setBudgetsByMode({
      month: '2026-06',
      mode: 'copy_last_month',
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    expect(actualApi.batchBudgetUpdates).toHaveBeenCalledOnce();
    expect(actualApi.setBudgetAmount).toHaveBeenCalledTimes(2);
    expect(actualApi.setBudgetAmount).toHaveBeenNthCalledWith(1, '2026-06', 'c1', 2000);
    expect(actualApi.setBudgetAmount).toHaveBeenNthCalledWith(2, '2026-06', 'c2', 300);
  });

  it('includes income categories when includeIncome is true', async () => {
    const result = await setBudgetsByMode({
      month: '2026-06',
      mode: 'copy_last_month',
      includeIncome: true,
    });

    expect(result.includeIncome).toBe(true);
    expect(result.categories.map((c) => c.id)).toEqual(['c1', 'c2', 'i1']);
    expect(result.categories[2]).toEqual({
      id: 'i1',
      name: 'Paycheck',
      isIncome: true,
      oldBudgeted: 5000,
      newBudgeted: 100,
    });
  });

  it('targets only the resolved category and ignores includeIncome', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'i1', name: 'Paycheck' });

    const result = await setBudgetsByMode({
      month: '2026-06',
      mode: 'copy_last_month',
      category: 'Paycheck',
      includeIncome: false,
    });

    expect(resolveCategory).toHaveBeenCalledWith('Paycheck');
    expect(result.categories).toEqual([
      { id: 'i1', name: 'Paycheck', isIncome: true, oldBudgeted: 5000, newBudgeted: 100 },
    ]);
  });

  it('defaults the month to the current month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));

    const result = await setBudgetsByMode({ mode: 'custom_amount', amount: 0 });

    expect(result.month).toBe('2026-06');
  });

  it('rejects a malformed month', async () => {
    await expect(
      setBudgetsByMode({ month: '2026-6', mode: 'copy_last_month' })
    ).rejects.toThrow(/Invalid month "2026-6" — expected YYYY-MM/);
  });

  it('rejects an unknown category', async () => {
    vi.mocked(resolveCategory).mockRejectedValueOnce(new Error('Category "Nope" not found'));

    await expect(
      setBudgetsByMode({ month: '2026-06', mode: 'copy_last_month', category: 'Nope' })
    ).rejects.toThrow(/Category "Nope" not found/);
  });

  it('requires an amount for custom_amount', async () => {
    await expect(
      setBudgetsByMode({ month: '2026-06', mode: 'custom_amount' })
    ).rejects.toThrow(/amount is required/);
  });

  it('rejects a non-integer amount for custom_amount', async () => {
    await expect(
      setBudgetsByMode({ month: '2026-06', mode: 'custom_amount', amount: 12.5 })
    ).rejects.toThrow(/amount is required/);
  });
});
