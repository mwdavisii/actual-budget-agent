import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBudgetStatus } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: { getBudgetMonth: vi.fn(), getCategoryGroups: vi.fn() },
}));
vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('getBudgetStatus', () => {
  it('excludes hidden categories and categories in hidden groups', async () => {
    // Authoritative visibility source.
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { name: 'Food', hidden: false, categories: [
        { id: 'c1', name: 'Groceries', hidden: false },
        { id: 'c2', name: 'OldSnacks', hidden: true },
      ]},
      { name: 'Archived', hidden: true, categories: [{ id: 'c3', name: 'X', hidden: false }] },
    ]);
    // Budget month returns everything, including the hidden ones.
    (actualApi.getBudgetMonth as any).mockResolvedValue({
      categoryGroups: [
        { is_income: false, categories: [
          { id: 'c1', name: 'Groceries', budgeted: 10000, spent: -4300, balance: 5700 },
          { id: 'c2', name: 'OldSnacks', budgeted: 0, spent: 0, balance: 0 },
        ]},
        { is_income: false, categories: [
          { id: 'c3', name: 'X', budgeted: 0, spent: 0, balance: 0 },
        ]},
      ],
    });

    const result = await getBudgetStatus('2026-06');

    expect(result).toEqual([
      { id: 'c1', name: 'Groceries', budgeted: 10000, spent: -4300, available: 5700, isIncome: false },
    ]);
  });

  it('defaults the month and maps balance to available', async () => {
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { name: 'Income', hidden: false, categories: [{ id: 'i1', name: 'Paycheck', hidden: false }] },
    ]);
    (actualApi.getBudgetMonth as any).mockResolvedValue({
      categoryGroups: [
        { is_income: true, categories: [{ id: 'i1', name: 'Paycheck', budgeted: 0, spent: 250000, balance: 250000 }] },
      ],
    });

    const result = await getBudgetStatus();

    expect(actualApi.getBudgetMonth).toHaveBeenCalledOnce();
    expect(result).toEqual([
      { id: 'i1', name: 'Paycheck', budgeted: 0, spent: 250000, available: 250000, isIncome: true },
    ]);
  });
});
