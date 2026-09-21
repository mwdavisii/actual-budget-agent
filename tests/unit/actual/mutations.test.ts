import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyCategory,
  setPayee,
  mergePayees,
  updateTransactionFields,
  applyCategoryBulk,
} from '../../../src/actual/mutations';
import { getTransactionById } from '../../../src/actual/queries';
import { resolveCategory, resolvePayee } from '../../../src/actual/naming';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    updateTransaction: vi.fn(),
    mergePayees: vi.fn(),
    runQuery: vi.fn(),
    batchBudgetUpdates: vi.fn((fn: () => Promise<void>) => fn()),
    getPayees: vi.fn(),
    getAccounts: vi.fn(),
    q: vi.fn(() => ({
      filter: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
    })),
  },
}));

vi.mock('../../../src/actual/queries', () => ({
  getTransactionById: vi.fn(),
}));

vi.mock('../../../src/actual/naming', () => ({
  resolveCategory: vi.fn(),
  resolvePayee: vi.fn(),
}));

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    date: '2026-06-22',
    amount: 1234,
    payee: 'pay-1',
    payeeName: 'ST. JUDE',
    category: null,
    categoryName: null,
    notes: '',
    account: 'acc-1',
    accountName: 'Checking',
    cleared: false,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('applyCategory', () => {
  it('is idempotent and skips updateTransaction when the category is already set', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById).mockResolvedValue(makeTx({ category: 'cat-1', categoryName: 'Dining Out' }));

    const result = await applyCategory('tx-1', 'Dining Out');

    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.tx.category).toBe('cat-1');
  });

  it('updates, then reads back the enriched transaction', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ category: null, categoryName: null }))
      .mockResolvedValueOnce(makeTx({ category: 'cat-1', categoryName: 'Dining Out' }));
    vi.mocked(actualApi.updateTransaction).mockResolvedValue([] as any);

    const result = await applyCategory('tx-1', 'Dining Out');

    expect(actualApi.updateTransaction).toHaveBeenCalledExactlyOnceWith('tx-1', { category: 'cat-1' });
    expect(result.changed).toBe(true);
    expect(result.tx.categoryName).toBe('Dining Out');
  });

  it('clears the category when null is passed', async () => {
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ category: 'cat-1', categoryName: 'Dining Out' }))
      .mockResolvedValueOnce(makeTx({ category: null, categoryName: null }));
    vi.mocked(actualApi.updateTransaction).mockResolvedValue([] as any);

    const result = await applyCategory('tx-1', null);

    expect(actualApi.updateTransaction).toHaveBeenCalledExactlyOnceWith('tx-1', { category: null });
    expect(result.changed).toBe(true);
    expect(result.tx.category).toBeNull();
  });

  it('throws when the transaction does not exist', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById).mockResolvedValue(null);

    await expect(applyCategory('tx-missing', 'Dining Out')).rejects.toThrow('Transaction tx-missing not found');
  });
});

describe('setPayee', () => {
  it('updates the payee and reads back the enriched transaction', async () => {
    vi.mocked(resolvePayee).mockResolvedValue({ id: 'pay-2', name: 'AMAZON', transferAcct: null });
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ payee: 'pay-1', payeeName: 'ST. JUDE' }))
      .mockResolvedValueOnce(makeTx({ payee: 'pay-2', payeeName: 'AMAZON' }));
    vi.mocked(actualApi.updateTransaction).mockResolvedValue([] as any);

    const result = await setPayee('tx-1', 'AMAZON');

    expect(actualApi.updateTransaction).toHaveBeenCalledExactlyOnceWith('tx-1', { payee: 'pay-2' });
    expect(result.changed).toBe(true);
    expect(result.tx.payeeName).toBe('AMAZON');
  });

  it('is idempotent when the payee is already set', async () => {
    vi.mocked(resolvePayee).mockResolvedValue({ id: 'pay-1', name: 'ST. JUDE', transferAcct: null });
    vi.mocked(getTransactionById).mockResolvedValue(makeTx({ payee: 'pay-1', payeeName: 'ST. JUDE' }));

    const result = await setPayee('tx-1', 'ST. JUDE');

    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });
});

describe('mergePayees', () => {
  it('rejects a transfer payee as the merge target', async () => {
    vi.mocked(resolvePayee).mockResolvedValue({
      id: 'pay-t',
      name: 'Transfer: Checking',
      transferAcct: 'acc-1',
    });

    await expect(mergePayees('Transfer: Checking', ['Source'], false)).rejects.toThrow(
      'Payee "Transfer: Checking" is a transfer payee and cannot be a merge target'
    );
  });

  it('rejects a transfer payee in the source list', async () => {
    vi.mocked(resolvePayee)
      .mockResolvedValueOnce({ id: 'pay-target', name: 'AMAZON', transferAcct: null })
      .mockResolvedValueOnce({ id: 'pay-source', name: 'Transfer: Checking', transferAcct: 'acc-1' });

    await expect(mergePayees('AMAZON', ['Transfer: Checking'], false)).rejects.toThrow(
      'Payee "Transfer: Checking" is a transfer payee and cannot be merged'
    );
  });

  it('rejects the target when it appears in sources', async () => {
    vi.mocked(resolvePayee).mockResolvedValue({ id: 'pay-1', name: 'AMAZON', transferAcct: null });

    await expect(mergePayees('AMAZON', ['AMAZON'], false)).rejects.toThrow(
      'Target payee cannot also be a source'
    );
  });

  it('rejects duplicate sources', async () => {
    vi.mocked(resolvePayee)
      .mockResolvedValueOnce({ id: 'pay-target', name: 'TARGET', transferAcct: null })
      .mockResolvedValue({ id: 'pay-1', name: 'AMAZON', transferAcct: null });

    await expect(mergePayees('TARGET', ['AMAZON', 'AMAZON'], false)).rejects.toThrow(
      'Duplicate source payee: AMAZON'
    );
  });

  it('returns a dry-run projection without calling mergePayees', async () => {
    vi.mocked(resolvePayee)
      .mockResolvedValueOnce({ id: 'pay-target', name: 'AMAZON', transferAcct: null })
      .mockResolvedValueOnce({ id: 'pay-s1', name: 'AMZN', transferAcct: null })
      .mockResolvedValueOnce({ id: 'pay-s2', name: 'AMAZON.COM', transferAcct: null });
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { payee: 'pay-target', count: 5 },
        { payee: 'pay-s1', count: 3 },
        { payee: 'pay-s2', count: 2 },
      ],
    } as any);

    const result = await mergePayees('AMAZON', ['AMZN', 'AMAZON.COM'], true);

    expect(actualApi.mergePayees).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.target).toEqual({ id: 'pay-target', name: 'AMAZON' });
    expect(result.sources).toEqual([
      { id: 'pay-s1', name: 'AMZN', txCount: 3 },
      { id: 'pay-s2', name: 'AMAZON.COM', txCount: 2 },
    ]);
    expect(result.projectedTargetTxCount).toBe(10);
  });

  it('calls mergePayees and re-fetches the target on a real run', async () => {
    vi.mocked(resolvePayee)
      .mockResolvedValueOnce({ id: 'pay-target', name: 'AMAZON', transferAcct: null })
      .mockResolvedValueOnce({ id: 'pay-s1', name: 'AMZN', transferAcct: null });
    vi.mocked(actualApi.runQuery).mockResolvedValue({
      data: [
        { payee: 'pay-target', count: 5 },
        { payee: 'pay-s1', count: 3 },
      ],
    } as any);
    vi.mocked(actualApi.mergePayees).mockResolvedValue(undefined);
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'pay-target', name: 'AMAZON' },
    ] as any);

    const result = await mergePayees('AMAZON', ['AMZN'], false);

    expect(actualApi.mergePayees).toHaveBeenCalledExactlyOnceWith('pay-target', ['pay-s1']);
    expect(result.dryRun).toBe(false);
    expect(result.target).toEqual({ id: 'pay-target', name: 'AMAZON' });
  });
});

describe('updateTransactionFields', () => {
  it('rejects transfer_id, payee, and category keys', async () => {
    await expect(updateTransactionFields('tx-1', { transfer_id: 'tx-2' })).rejects.toThrow(
      'Updating transfer_id is not supported'
    );
    await expect(updateTransactionFields('tx-1', { payee: 'pay-1' })).rejects.toThrow(
      'Updating payee is not supported'
    );
    await expect(updateTransactionFields('tx-1', { category: 'cat-1' })).rejects.toThrow(
      'Updating category is not supported'
    );
  });

  it('updates allowed fields and reads back the transaction', async () => {
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ notes: 'old', cleared: false }))
      .mockResolvedValueOnce(makeTx({ notes: 'new', cleared: true }));
    vi.mocked(actualApi.updateTransaction).mockResolvedValue([] as any);

    const result = await updateTransactionFields('tx-1', { notes: 'new', cleared: true });

    expect(actualApi.updateTransaction).toHaveBeenCalledExactlyOnceWith('tx-1', {
      notes: 'new',
      cleared: true,
    });
    expect(result.changed).toBe(true);
    expect(result.tx.notes).toBe('new');
  });
});

describe('applyCategoryBulk', () => {
  it('dry-run returns projections and performs zero mutations', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ id: 'tx-1', category: null, categoryName: null }))
      .mockResolvedValueOnce(makeTx({ id: 'tx-2', category: 'cat-2', categoryName: 'Groceries' }));

    const result = await applyCategoryBulk(['tx-1', 'tx-2'], 'Dining Out', true);

    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(actualApi.batchBudgetUpdates).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.results).toEqual([
      { txId: 'tx-1', changed: true, before: null, after: 'cat-1' },
      { txId: 'tx-2', changed: true, before: 'cat-2', after: 'cat-1' },
    ]);
  });

  it('applies non-atomically: row 2 fails while rows 1 and 3 are applied', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce(makeTx({ id: 'tx-1', category: null, categoryName: null }))
      .mockResolvedValueOnce(makeTx({ id: 'tx-1', category: 'cat-1', categoryName: 'Dining Out' }))
      .mockResolvedValueOnce(makeTx({ id: 'tx-2', category: null, categoryName: null }))
      .mockResolvedValueOnce(makeTx({ id: 'tx-3', category: null, categoryName: null }))
      .mockResolvedValueOnce(makeTx({ id: 'tx-3', category: 'cat-1', categoryName: 'Dining Out' }));
    vi.mocked(actualApi.updateTransaction)
      .mockResolvedValueOnce([] as any)
      .mockRejectedValueOnce(new Error('row 2 failed'))
      .mockResolvedValueOnce([] as any);

    const result = await applyCategoryBulk(['tx-1', 'tx-2', 'tx-3'], 'Dining Out', false);

    expect(actualApi.batchBudgetUpdates).toHaveBeenCalledTimes(1);
    expect(actualApi.updateTransaction).toHaveBeenCalledTimes(3);
    expect(result.applied).toBe(2);
    expect(result.results[0]).toEqual({ txId: 'tx-1', changed: true, before: null, after: 'cat-1' });
    expect(result.results[1]).toMatchObject({ txId: 'tx-2', changed: false, error: 'Error: row 2 failed' });
    expect(result.results[2]).toEqual({ txId: 'tx-3', changed: true, before: null, after: 'cat-1' });
  });

  it('skips update for rows that already have the target category', async () => {
    vi.mocked(resolveCategory).mockResolvedValue({ id: 'cat-1', name: 'Dining Out' });
    vi.mocked(getTransactionById).mockResolvedValue(makeTx({ id: 'tx-1', category: 'cat-1', categoryName: 'Dining Out' }));

    const result = await applyCategoryBulk(['tx-1'], 'Dining Out', false);

    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.results[0]).toEqual({ txId: 'tx-1', changed: false, before: 'cat-1', after: 'cat-1' });
  });
});
