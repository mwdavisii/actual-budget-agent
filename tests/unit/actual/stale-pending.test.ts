import { describe, it, expect } from 'vitest';
import { findMatches, type UnclearedTransaction, type ClearedCandidate } from '../../../src/actual/stale-pending';

describe('findMatches', () => {
  const base: UnclearedTransaction = {
    id: 'tx-1',
    date: '2026-03-20',
    amount: -2500, // $25.00
    payee: 'payee-abc',
    payeeName: "Huey's Cordova",
    category: 'cat-dining',
    categoryName: 'Dining Out',
    account: 'acct-1',
    accountName: 'Checking',
    cleared: false,
  };

  it('matches a cleared transaction from same payee, same account, higher amount, within date window', () => {
    const uncleared: UnclearedTransaction[] = [base];
    const cleared: ClearedCandidate[] = [{
      id: 'tx-2',
      date: '2026-03-21',
      amount: -3000, // $30.00 (with tip)
      payee: 'payee-abc',
      account: 'acct-1',
    }];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(1);
    expect(result[0].pending.id).toBe('tx-1');
    expect(result[0].cleared.id).toBe('tx-2');
  });

  it('rejects match from different account', () => {
    const uncleared: UnclearedTransaction[] = [base];
    const cleared: ClearedCandidate[] = [{
      id: 'tx-2',
      date: '2026-03-21',
      amount: -3000,
      payee: 'payee-abc',
      account: 'acct-OTHER',
    }];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(0);
  });

  it('rejects match from different payee', () => {
    const uncleared: UnclearedTransaction[] = [base];
    const cleared: ClearedCandidate[] = [{
      id: 'tx-2',
      date: '2026-03-21',
      amount: -3000,
      payee: 'payee-OTHER',
      account: 'acct-1',
    }];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(0);
  });

  it('rejects match where cleared amount is less than pending', () => {
    const uncleared: UnclearedTransaction[] = [base];
    const cleared: ClearedCandidate[] = [{
      id: 'tx-2',
      date: '2026-03-21',
      amount: -2000, // less than pending (less negative = smaller spend)
      payee: 'payee-abc',
      account: 'acct-1',
    }];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(0);
  });

  it('rejects match outside date window', () => {
    const uncleared: UnclearedTransaction[] = [base];
    const cleared: ClearedCandidate[] = [{
      id: 'tx-2',
      date: '2026-03-28', // 8 days later, outside 3-day window
      amount: -3000,
      payee: 'payee-abc',
      account: 'acct-1',
    }];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(0);
  });

  it('handles multiple uncleared, each matched to closest cleared', () => {
    const uncleared: UnclearedTransaction[] = [
      { ...base, id: 'tx-1', date: '2026-03-18', amount: -2000 },
      { ...base, id: 'tx-3', date: '2026-03-20', amount: -2500 },
    ];
    const cleared: ClearedCandidate[] = [
      { id: 'tx-2', date: '2026-03-19', amount: -2400, payee: 'payee-abc', account: 'acct-1' },
      { id: 'tx-4', date: '2026-03-21', amount: -3000, payee: 'payee-abc', account: 'acct-1' },
    ];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(2);
    const clearedIds = result.map(r => r.cleared.id);
    expect(new Set(clearedIds).size).toBe(2);
  });

  it('does not reuse a cleared transaction for multiple pending', () => {
    const uncleared: UnclearedTransaction[] = [
      { ...base, id: 'tx-1', date: '2026-03-20', amount: -2000 },
      { ...base, id: 'tx-3', date: '2026-03-20', amount: -2500 },
    ];
    const cleared: ClearedCandidate[] = [
      { id: 'tx-2', date: '2026-03-21', amount: -3000, payee: 'payee-abc', account: 'acct-1' },
    ];
    const result = findMatches(uncleared, cleared, 3);
    expect(result).toHaveLength(1);
  });
});
