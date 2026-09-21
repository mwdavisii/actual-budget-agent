import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAnalysisTools } from '../../../src/mcp/tools/analysis';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/queries', () => ({
  getTransactionById: vi.fn(),
}));

vi.mock('../../../src/actual/analysis', () => ({
  getUnreconciled: vi.fn(),
  findDuplicatePayees: vi.fn(),
}));

async function connectAnalysisToolsClient() {
  const server = new McpServer({ name: 'budget-analysis-test', version: '1.0.0' });
  registerAnalysisTools(server, { db: {} as never });
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

describe('MCP analysis tools', () => {
  it('lists all three analysis tools', async () => {
    const client = await connectAnalysisToolsClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['get_transaction', 'get_unreconciled', 'find_duplicate_payees']) {
      expect(names).toContain(n);
    }
  });

  it('get_transaction returns mocked tx JSON', async () => {
    const { getTransactionById } = await import('../../../src/actual/queries');
    const mocked = { id: 'tx-1', amount: 1234, payeeName: 'Coffee Shop' };
    (getTransactionById as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectAnalysisToolsClient();
    const res = await client.callTool({ name: 'get_transaction', arguments: { txId: 'tx-1' } });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(getTransactionById).toHaveBeenCalledWith('tx-1');
  });

  it('get_transaction unknown txId returns errorContent not-found', async () => {
    const { getTransactionById } = await import('../../../src/actual/queries');
    (getTransactionById as unknown as { mockResolvedValueOnce: (v: null) => void }).mockResolvedValueOnce(null);

    const client = await connectAnalysisToolsClient();
    const res = await client.callTool({ name: 'get_transaction', arguments: { txId: 'missing' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('Transaction missing not found');
  });

  it('get_unreconciled passes accountId through', async () => {
    const { getUnreconciled } = await import('../../../src/actual/analysis');
    const mocked = { accountId: 'acc-1', unreconciledCount: 0, transactions: [] };
    (getUnreconciled as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectAnalysisToolsClient();
    const res = await client.callTool({ name: 'get_unreconciled', arguments: { accountId: 'acc-1' } });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(getUnreconciled).toHaveBeenCalledWith('acc-1');
  });

  it('find_duplicate_payees returns mocked groups', async () => {
    const { findDuplicatePayees } = await import('../../../src/actual/analysis');
    const mocked = [
      { normalized: 'starbucks', canonical: { id: 'p1', name: 'Starbucks', count: 5 }, duplicates: [] },
    ];
    (findDuplicatePayees as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectAnalysisToolsClient();
    const res = await client.callTool({ name: 'find_duplicate_payees', arguments: {} });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(findDuplicatePayees).toHaveBeenCalledWith();
  });

  it('surfaces a mocked upstream failure as an Actual Budget read failed tool error', async () => {
    const { getTransactionById } = await import('../../../src/actual/queries');
    (getTransactionById as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('actual unreachable')
    );

    const client = await connectAnalysisToolsClient();
    const res = await client.callTool({ name: 'get_transaction', arguments: { txId: 'tx-1' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/Actual Budget read failed/i);
  });
});
