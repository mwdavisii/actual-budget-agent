import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAccounts, getTransactions, getUncategorizedTransactions } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

const chain = {
  filter: vi.fn().mockReturnThis(),
  options: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
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

beforeEach(() => vi.clearAllMocks());

describe('getAccounts', () => {
  it('maps accounts to { id, name, closed, offbudget, balance } using getAccountBalance', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
      { id: 'a2', name: 'Savings', closed: false, offbudget: true },
    ]);
    (actualApi.getAccountBalance as any).mockResolvedValueOnce(12345).mockResolvedValueOnce(-678);

    const result = await getAccounts();

    expect(actualApi.getAccountBalance).toHaveBeenCalledWith('a1');
    expect(actualApi.getAccountBalance).toHaveBeenCalledWith('a2');
    expect(result).toEqual([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false, balance: 12345 },
      { id: 'a2', name: 'Savings', closed: false, offbudget: true, balance: -678 },
    ]);
  });

  it('falls back to empty name when account name is missing', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([
      { id: 'a3', closed: true, offbudget: false },
    ]);
    (actualApi.getAccountBalance as any).mockResolvedValue(0);

    const result = await getAccounts();

    expect(result[0].name).toBe('');
  });

  it('propagates rejection from getAccountBalance', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
    ]);
    (actualApi.getAccountBalance as any).mockRejectedValue(new Error('balance failed'));

    await expect(getAccounts()).rejects.toThrow('balance failed');
  });
});

describe('getTransactions cleared filter', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([]);
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });
  });

  it('adds { cleared: false } filter when cleared is false', async () => {
    await getTransactions({ cleared: false });

    expect(chain.filter).toHaveBeenCalledWith(expect.objectContaining({ cleared: false }));
  });

  it('adds { cleared: true } filter when cleared is true', async () => {
    await getTransactions({ cleared: true });

    expect(chain.filter).toHaveBeenCalledWith(expect.objectContaining({ cleared: true }));
  });

  it('does not add a cleared filter when cleared is absent', async () => {
    await getTransactions({});

    const clearedCalls = chain.filter.mock.calls.filter((call: any[]) =>
      call[0] && Object.prototype.hasOwnProperty.call(call[0], 'cleared')
    );
    expect(clearedCalls).toHaveLength(0);
  });
});

describe('transaction cleared field mapping', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([]);
  });

  it('getTransactions sets cleared true/false from row data', async () => {
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { id: 't1', date: '2026-06-22', amount: 100, payee: 'p1', category: 'c1', notes: '', account: 'a1', cleared: true },
        { id: 't2', date: '2026-06-22', amount: 200, payee: 'p1', category: 'c1', notes: '', account: 'a1', cleared: false },
      ],
    });

    const result = await getTransactions({});

    expect(result[0].cleared).toBe(true);
    expect(result[1].cleared).toBe(false);
  });

  it('getTransactions coerces missing cleared to false (stale state)', async () => {
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { id: 't1', date: '2026-06-22', amount: 100, payee: 'p1', category: 'c1', notes: '', account: 'a1' },
      ],
    });

    const result = await getTransactions({});

    expect(result[0].cleared).toBe(false);
  });

  it('getUncategorizedTransactions sets cleared true/false from row data', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking', closed: false, offbudget: false }]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { id: 't1', date: '2026-06-22', amount: 100, payee: 'p1', notes: '', account: 'a1', cleared: true },
        { id: 't2', date: '2026-06-22', amount: 200, payee: 'p1', notes: '', account: 'a1', cleared: false },
      ],
    });

    const result = await getUncategorizedTransactions();

    expect(result[0].cleared).toBe(true);
    expect(result[1].cleared).toBe(false);
  });

  it('getUncategorizedTransactions coerces missing cleared to false (stale state)', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking', closed: false, offbudget: false }]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { id: 't1', date: '2026-06-22', amount: 100, payee: 'p1', notes: '', account: 'a1' },
      ],
    });

    const result = await getUncategorizedTransactions();

    expect(result[0].cleared).toBe(false);
  });
});
