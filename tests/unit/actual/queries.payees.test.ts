import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUncategorizedTransactions, getTransactions } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => {
  const chain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  return {
    actualApi: {
      getAccounts: vi.fn(),
      getPayees: vi.fn(),
      runQuery: vi.fn(),
      q: vi.fn(() => chain),
    },
  };
});
vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('payee name resolution', () => {
  it('getUncategorizedTransactions resolves payeeName (and accountName) from ids', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
    ]);
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [{ id: 't1', date: '2026-06-22', amount: 76126, payee: 'p1', notes: 'Memo Credit', account: 'a1' }],
    });

    const result = await getUncategorizedTransactions();

    expect(result[0].payee).toBe('p1');
    expect(result[0].payeeName).toBe('ST. JUDE');
    expect(result[0].accountName).toBe('Checking');
  });

  it('getTransactions resolves payeeName and falls back to empty for an unknown payee id', async () => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { id: 't1', date: '2026-06-22', amount: 76126, payee: 'p1', category: 'c1', notes: '', account: 'a1' },
        { id: 't2', date: '2026-06-18', amount: -9300, payee: 'pX', category: 'c1', notes: '', account: 'a1' },
      ],
    });

    const result = await getTransactions({ amountMin: 0 });

    expect(result[0].payeeName).toBe('ST. JUDE');
    expect(result[0].accountName).toBe('Checking');
    expect(result[1].payeeName).toBe('');
  });
});
