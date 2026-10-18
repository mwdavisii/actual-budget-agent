import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { matchTransferPairs, type TransferTx } from '../../../src/actual/transfers';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getPayees: vi.fn(),
    getAccounts: vi.fn(),
    runQuery: vi.fn(),
    updateTransaction: vi.fn(),
    batchBudgetUpdates: vi.fn((fn: () => Promise<void>) => fn()),
    q: vi.fn(),
  },
}));

const q = actualApi.q as unknown as Mock;
const runQuery = actualApi.runQuery as unknown as Mock;

function tx(overrides: Partial<TransferTx> = {}): TransferTx {
  return {
    id: 'tx-1',
    date: '2026-10-01',
    amount: -5000,
    account: 'acc-checking',
    accountName: 'Checking',
    payee: 'p-1',
    payeeName: 'Payment',
    cleared: false,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('matchTransferPairs', () => {
  it('pairs exact opposite amounts across accounts within the window as unique', () => {
    const a = tx({ id: 'a', date: '2026-10-01', amount: -5000, account: 'acc-checking' });
    const b = tx({ id: 'b', date: '2026-10-03', amount: 5000, account: 'acc-card' });
    const pairs = matchTransferPairs([b, a], 3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe('a'); // earlier date first
    expect(pairs[0].b.id).toBe('b');
    expect(pairs[0].daysApart).toBe(2);
    expect(pairs[0].confidence).toBe('unique');
  });

  it('ignores rows in the same account', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const b = tx({ id: 'b', amount: 5000, account: 'acc-1' });
    expect(matchTransferPairs([a, b], 3)).toEqual([]);
  });

  it('includes pairs exactly at the window edge and excludes beyond it', () => {
    const a = tx({ id: 'a', date: '2026-10-01', amount: -5000, account: 'acc-1' });
    const atEdge = tx({ id: 'b', date: '2026-10-04', amount: 5000, account: 'acc-2' });
    const beyond = tx({ id: 'c', date: '2026-10-05', amount: 5000, account: 'acc-3' });
    expect(matchTransferPairs([a, atEdge], 3)).toHaveLength(1);
    expect(matchTransferPairs([a, beyond], 3)).toEqual([]);
  });

  it('ignores amounts that are not exactly opposite and zero amounts', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const off = tx({ id: 'b', amount: 5001, account: 'acc-2' });
    const z1 = tx({ id: 'z1', amount: 0, account: 'acc-1' });
    const z2 = tx({ id: 'z2', amount: 0, account: 'acc-2' });
    expect(matchTransferPairs([a, off, z1, z2], 3)).toEqual([]);
  });

  it('marks every pair ambiguous when a row has more than one possible counterpart', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const b = tx({ id: 'b', amount: 5000, account: 'acc-2' });
    const c = tx({ id: 'c', amount: 5000, account: 'acc-3' });
    const pairs = matchTransferPairs([a, b, c], 3);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.confidence === 'ambiguous')).toBe(true);
  });

  it('sorts pairs by date distance, then earliest date, then id', () => {
    const a1 = tx({ id: 'a1', date: '2026-10-01', amount: -1000, account: 'acc-1' });
    const b1 = tx({ id: 'b1', date: '2026-10-03', amount: 1000, account: 'acc-2' });
    const a2 = tx({ id: 'a2', date: '2026-10-10', amount: -2000, account: 'acc-1' });
    const b2 = tx({ id: 'b2', date: '2026-10-10', amount: 2000, account: 'acc-2' });
    const pairs = matchTransferPairs([a1, b1, a2, b2], 3);
    expect(pairs.map((p) => p.a.id)).toEqual(['a2', 'a1']);
  });
});
