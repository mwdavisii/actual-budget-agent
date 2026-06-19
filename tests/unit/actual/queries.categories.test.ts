import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCategories } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: { getCategoryGroups: vi.fn() },
}));
vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('getCategories', () => {
  it('returns non-hidden groups with non-hidden category names', async () => {
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { name: 'Food', hidden: false, categories: [
        { name: 'Groceries', hidden: false },
        { name: 'OldSnacks', hidden: true },
      ]},
      { name: 'Archived', hidden: true, categories: [{ name: 'X', hidden: false }] },
    ]);
    const result = await getCategories();
    expect(result).toEqual([{ group: 'Food', categories: ['Groceries'] }]);
  });

  it('handles a group with no categories array', async () => {
    (actualApi.getCategoryGroups as any).mockResolvedValue([{ name: 'Empty', hidden: false }]);
    const result = await getCategories();
    expect(result).toEqual([{ group: 'Empty', categories: [] }]);
  });
});
