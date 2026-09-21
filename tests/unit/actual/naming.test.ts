import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suggestClosest, resolveCategory, resolvePayee } from '../../../src/actual/naming';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getCategoryGroups: vi.fn(),
    getPayees: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('suggestClosest', () => {
  it('ranks substring match above prefix match above Levenshtein distance', () => {
    const candidates = ['Amex Card', 'Amazon', 'Amtrak', 'American Airlines', 'Coffee'];
    const result = suggestClosest('Amex', candidates, 3);
    expect(result).toEqual(['Amex Card', 'Amazon', 'Amtrak']);
  });

  it('excludes exact case-insensitive matches', () => {
    const result = suggestClosest('groceries', ['Groceries', 'Grocery Outlet'], 3);
    expect(result).toEqual(['Grocery Outlet']);
  });

  it('returns up to the requested limit', () => {
    const candidates = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    expect(suggestClosest('a', candidates, 2)).toHaveLength(2);
  });

  it('returns an empty array when no candidates remain', () => {
    expect(suggestClosest('foo', ['foo'], 3)).toEqual([]);
  });
});

describe('resolveCategory', () => {
  it('resolves by exact name match case-insensitively', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { categories: [{ id: 'cat-1', name: 'Dining Out' }] },
    ] as any);

    const result = await resolveCategory('dining out');
    expect(result).toEqual({ id: 'cat-1', name: 'Dining Out' });
  });

  it('resolves by UUID prefix when the id exists', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { categories: [{ id: 'a1b2c3d4-1234-5678-9abc-def012345678', name: 'Groceries' }] },
    ] as any);

    const result = await resolveCategory('a1b2c3d4-1234-5678-9abc-def012345678');
    expect(result).toEqual({ id: 'a1b2c3d4-1234-5678-9abc-def012345678', name: 'Groceries' });
  });

  it('rejects an empty string with the clear-category hint', async () => {
    await expect(resolveCategory('')).rejects.toThrow(
      'Category cannot be empty — pass null to clear a category'
    );
    expect(actualApi.getCategoryGroups).not.toHaveBeenCalled();
  });

  it('throws with suggestions when the name is unknown', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { categories: [{ id: 'cat-1', name: 'Groceries' }] },
      { categories: [{ id: 'cat-2', name: 'Dining Out' }] },
    ] as any);

    await expect(resolveCategory('Nonexistent')).rejects.toThrow(
      'Category "Nonexistent" not found — did you mean: Groceries, Dining Out?'
    );
  });
});

describe('resolvePayee', () => {
  it('resolves by exact name match case-insensitively', async () => {
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'pay-1', name: 'ST. JUDE' },
    ] as any);

    const result = await resolvePayee('st. jude');
    expect(result).toEqual({ id: 'pay-1', name: 'ST. JUDE', transferAcct: null });
  });

  it('resolves by UUID when the id exists', async () => {
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'ST. JUDE' },
    ] as any);

    const result = await resolvePayee('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result).toEqual({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'ST. JUDE', transferAcct: null });
  });

  it('rejects an empty string', async () => {
    await expect(resolvePayee('')).rejects.toThrow('Payee name cannot be empty');
    expect(actualApi.getPayees).not.toHaveBeenCalled();
  });

  it('excludes transfer payees from suggestions', async () => {
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'pay-1', name: 'ST. JUDE' },
      { id: 'pay-2', name: 'Transfer: Checking', transfer_acct: 'acc-1' },
    ] as any);

    await expect(resolvePayee('Judez')).rejects.toThrow(
      'Payee "Judez" not found — did you mean: ST. JUDE?'
    );
  });
});
