import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUnreconciled, findDuplicatePayees } from '../../../src/actual/analysis';
import { actualApi } from '../../../src/actual/client';

const chain = {
  filter: vi.fn().mockReturnThis(),
  options: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  calculate: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
};

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getAccounts: vi.fn(),
    getAccountBalance: vi.fn(),
    getPayees: vi.fn(),
    runQuery: vi.fn(),
    q: vi.fn(() => chain),
  },
}));
vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(chain).forEach((mock) => (mock as ReturnType<typeof vi.fn>).mockClear?.());
});

describe('findDuplicatePayees', () => {
  it('collapses memo variants into one group with highest-count canonical', async () => {
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'Starbucks', transfer_acct: null },
      { id: 'p2', name: 'Starbucks #123', transfer_acct: null },
      { id: 'p3', name: 'Starbucks-456!', transfer_acct: null },
      { id: 'p4', name: 'Amazon', transfer_acct: null },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { payee: 'p1', count: 5, minDate: '2026-01-01', maxDate: '2026-06-01' },
        { payee: 'p2', count: 2, minDate: '2026-02-01', maxDate: '2026-03-01' },
        { payee: 'p3', count: 1, minDate: '2026-04-01', maxDate: '2026-05-01' },
        { payee: 'p4', count: 3, minDate: '2026-01-15', maxDate: '2026-05-15' },
      ],
    });

    const result = await findDuplicatePayees();

    expect(result).toHaveLength(1);
    const group = result[0];
    expect(group.normalized).toBe('starbucks');
    expect(group.canonical).toEqual({ id: 'p1', name: 'Starbucks', count: 5 });
    expect(group.duplicates).toEqual([
      { id: 'p2', name: 'Starbucks #123', count: 2, firstDate: '2026-02-01', lastDate: '2026-03-01' },
      { id: 'p3', name: 'Starbucks-456!', count: 1, firstDate: '2026-04-01', lastDate: '2026-05-01' },
    ]);
  });

  it('excludes transfer payees from duplicate detection', async () => {
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'Starbucks', transfer_acct: null },
      { id: 'p2', name: 'Starbucks 1', transfer_acct: 'a1' },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [{ payee: 'p1', count: 1, minDate: '2026-01-01', maxDate: '2026-01-01' }],
    });

    const result = await findDuplicatePayees();

    expect(result).toHaveLength(0);
  });

  it('ignores single-id normalized groups', async () => {
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'Starbucks', transfer_acct: null },
      { id: 'p2', name: 'Costco', transfer_acct: null },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { payee: 'p1', count: 5, minDate: '2026-01-01', maxDate: '2026-06-01' },
        { payee: 'p2', count: 3, minDate: '2026-02-01', maxDate: '2026-05-01' },
      ],
    });

    const result = await findDuplicatePayees();

    expect(result).toHaveLength(0);
  });
});

describe('getUnreconciled', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false, last_reconciled: '2026-06-01' },
    ]);
    (actualApi.getAccountBalance as any).mockResolvedValue(100000);
  });

  it('throws with suggestions for an unknown account id', async () => {
    await expect(getUnreconciled('a2')).rejects.toThrow(
      'Account "a2" not found — did you mean: Checking?'
    );
  });

  it('returns count 0 and empty transactions when all transactions are cleared', async () => {
    (actualApi.runQuery as any)
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: 54844 });

    const result = await getUnreconciled('a1');

    expect(result).toEqual({
      accountId: 'a1',
      accountName: 'Checking',
      lastReconciled: '2026-06-01',
      currentBalance: 100000,
      clearedBalance: 54844,
      unreconciledCount: 0,
      transactions: [],
    });
    expect(actualApi.runQuery).toHaveBeenCalledTimes(2);
  });

  it('reads clearedBalance scalar as Number(result.data ?? 0)', async () => {
    (actualApi.runQuery as any)
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: 54844 });

    const result = await getUnreconciled('a1');

    expect(result.clearedBalance).toBe(54844);
  });

  it('returns uncleared rows with runningBalance ordered by date then id', async () => {
    (actualApi.runQuery as any)
      .mockResolvedValueOnce({
        data: [
          { id: 't2', date: '2026-06-02', amount: -500, payee: 'p1', notes: '', account: 'a1', cleared: false },
          { id: 't1', date: '2026-06-01', amount: 1000, payee: 'p2', notes: '', account: 'a1', cleared: false },
        ],
      })
      .mockResolvedValueOnce({ data: 54844 });

    const result = await getUnreconciled('a1');

    expect(result.unreconciledCount).toBe(2);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      id: 't1',
      date: '2026-06-01',
      amount: 1000,
      runningBalance: 1000,
    });
    expect(result.transactions[1]).toMatchObject({
      id: 't2',
      date: '2026-06-02',
      amount: -500,
      runningBalance: 500,
    });
  });
});
