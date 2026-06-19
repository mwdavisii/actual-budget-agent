import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBudgetMcpServer } from '../../../src/mcp/server';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/queries', () => ({
  getUncategorizedTransactions: vi.fn().mockResolvedValue([{ id: 't1', payee: 'Shop' }]),
  getTransactions: vi.fn().mockResolvedValue([{ id: 't2' }]),
  getBudgetStatus: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Groceries', budgeted: 100, spent: 0, available: 100, isIncome: false }]),
  getCategories: vi.fn().mockResolvedValue([{ group: 'Food', categories: ['Groceries'] }]),
  getScheduledTransactions: vi.fn().mockResolvedValue([{ id: 's1' }]),
  setCategoryForTransaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/targets', () => ({
  getTargetsWithLive: vi.fn().mockReturnValue([{ categoryName: 'Groceries', target: 100, budgeted: 80, gap: 20 }]),
  getUnderfundedCategories: vi.fn().mockReturnValue([{ categoryName: 'Groceries', target: 100, budgeted: 80, gap: 20 }]),
}));

async function connectClient() {
  const server = createBudgetMcpServer({ db: {} as never });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return client;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

beforeEach(() => vi.clearAllMocks());

describe('budget MCP tools', () => {
  it('lists the first tool', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_uncategorized_transactions');
  });

  it('list_uncategorized_transactions returns the transactions', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'list_uncategorized_transactions', arguments: {} });
    expect(textOf(res as never)).toContain('t1');
  });

  it('lists all read tools', async () => {
    const client = await connectClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['query_transactions', 'get_budget_status', 'list_categories', 'get_schedules']) {
      expect(names).toContain(n);
    }
  });

  it('query_transactions forwards filters and returns results', async () => {
    const { getTransactions } = await import('../../../src/actual/queries');
    const client = await connectClient();
    const res = await client.callTool({ name: 'query_transactions', arguments: { startDate: '2026-01-01' } });
    expect(textOf(res as never)).toContain('t2');
    expect(getTransactions).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-01-01' }));
  });

  it('get_budget_status returns categories', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'get_budget_status', arguments: {} });
    expect(textOf(res as never)).toContain('Groceries');
  });

  it('list_categories returns groups', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'list_categories', arguments: {} });
    expect(textOf(res as never)).toContain('Food');
  });

  it('get_schedules returns schedules', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'get_schedules', arguments: {} });
    expect(textOf(res as never)).toContain('s1');
  });

  it('get_targets returns merged targets', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'get_targets', arguments: {} });
    expect(textOf(res as never)).toContain('Groceries');
    expect(textOf(res as never)).toContain('gap');
  });

  it('get_underfunded returns gaps', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'get_underfunded', arguments: {} });
    expect(textOf(res as never)).toContain('Groceries');
  });

  it('apply_category applies and reports success', async () => {
    const { setCategoryForTransaction } = await import('../../../src/actual/queries');
    const client = await connectClient();
    const res = await client.callTool({ name: 'apply_category', arguments: { txId: 't9', category: 'Groceries' } });
    expect(textOf(res as never)).toContain('t9');
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    expect(setCategoryForTransaction).toHaveBeenCalledWith('t9', 'Groceries');
  });

  it('apply_category surfaces a connectivity failure as a write-failed tool error', async () => {
    const { setCategoryForTransaction } = await import('../../../src/actual/queries');
    (setCategoryForTransaction as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('actual unreachable'));
    const client = await connectClient();
    const res = await client.callTool({ name: 'apply_category', arguments: { txId: 't9', category: 'Groceries' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/write failed/i);
  });

  it('apply_category with unknown category returns a tool error', async () => {
    const { setCategoryForTransaction } = await import('../../../src/actual/queries');
    (setCategoryForTransaction as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('Category "Nope" not found'));
    const client = await connectClient();
    const res = await client.callTool({ name: 'apply_category', arguments: { txId: 't9', category: 'Nope' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/not found/i);
  });
});

export { connectClient, textOf };
