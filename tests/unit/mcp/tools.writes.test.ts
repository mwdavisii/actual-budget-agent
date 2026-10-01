import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriteTools } from '../../../src/mcp/tools/writes';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/mutations', () => ({
  applyCategoryBulk: vi.fn(),
  setPayee: vi.fn(),
  mergePayees: vi.fn(),
  updateTransactionFields: vi.fn(),
  deleteTransaction: vi.fn(),
}));

vi.mock('../../../src/actual/queries', () => ({
  getPayeesWithCounts: vi.fn(),
}));

async function connectWriteToolsClient() {
  const server = new McpServer({ name: 'budget-writes-test', version: '1.0.0' });
  registerWriteTools(server, { db: {} as never });
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

describe('MCP write tools', () => {
  it('lists all six write tools', async () => {
    const client = await connectWriteToolsClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'apply_category_bulk',
      'set_payee',
      'list_payees',
      'merge_payees',
      'update_transaction',
      'delete_transaction',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('apply_category_bulk dry-run echoes the mocked bulk result', async () => {
    const { applyCategoryBulk } = await import('../../../src/actual/mutations');
    const mocked = {
      dryRun: true,
      category: 'Dining',
      applied: 0,
      results: [{ txId: 'a', changed: true, before: null, after: 'cat-dining' }],
    };
    (applyCategoryBulk as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectWriteToolsClient();
    const res = await client.callTool({
      name: 'apply_category_bulk',
      arguments: { txIds: ['a'], category: 'Dining', dryRun: true },
    });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(applyCategoryBulk).toHaveBeenCalledWith(['a'], 'Dining', true);
  });

  it('set_payee unknown payee surfaces the did-you-mean text as a tool error', async () => {
    const { setPayee } = await import('../../../src/actual/mutations');
    (setPayee as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('Payee "Unknown" not found — did you mean: Unknown Shop?')
    );

    const client = await connectWriteToolsClient();
    const res = await client.callTool({ name: 'set_payee', arguments: { txId: 't1', payee: 'Unknown' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('did you mean');
  });

  it('surfaces a mocked upstream failure as an Actual Budget write failed tool error', async () => {
    const { applyCategoryBulk } = await import('../../../src/actual/mutations');
    (applyCategoryBulk as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('actual unreachable')
    );

    const client = await connectWriteToolsClient();
    const res = await client.callTool({
      name: 'apply_category_bulk',
      arguments: { txIds: ['a'], category: 'Dining' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/Actual Budget write failed/i);
  });

  it('merge_payees defaults to dryRun=true', async () => {
    const { mergePayees } = await import('../../../src/actual/mutations');
    const mocked = {
      dryRun: true,
      target: { id: 'p-target', name: 'Target' },
      sources: [{ id: 'p-source', name: 'Source', txCount: 3 }],
      projectedTargetTxCount: 7,
    };
    (mergePayees as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectWriteToolsClient();
    const res = await client.callTool({
      name: 'merge_payees',
      arguments: { targetPayee: 'Target', sourcePayees: ['Source'] },
    });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(mergePayees).toHaveBeenCalledWith('Target', ['Source'], true);
  });

  it('delete_transaction returns success when deletion succeeds', async () => {
    const { deleteTransaction } = await import('../../../src/actual/mutations');
    (deleteTransaction as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      txId: 'tx-1',
      deleted: true,
    });

    const client = await connectWriteToolsClient();
    const res = await client.callTool({ name: 'delete_transaction', arguments: { txId: 'tx-1' } });
    expect(JSON.parse(textOf(res as never))).toEqual({ success: true, txId: 'tx-1', deleted: true });
    expect(deleteTransaction).toHaveBeenCalledWith('tx-1');
  });

  it('delete_transaction returns a tool error when transaction is not found', async () => {
    const { deleteTransaction } = await import('../../../src/actual/mutations');
    (deleteTransaction as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('Transaction tx-missing not found')
    );

    const client = await connectWriteToolsClient();
    const res = await client.callTool({ name: 'delete_transaction', arguments: { txId: 'tx-missing' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('Transaction tx-missing not found');
  });
});
