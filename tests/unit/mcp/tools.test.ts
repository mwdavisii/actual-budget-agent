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
});

export { connectClient, textOf };
