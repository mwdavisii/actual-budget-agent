import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTransferTools } from '../../../src/mcp/tools/transfers';
import { findTransferCandidates, linkTransfer, TransferLinkError } from '../../../src/actual/transfers';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/transfers', async (orig) => ({
  ...(await orig<typeof import('../../../src/actual/transfers')>()),
  findTransferCandidates: vi.fn(),
  linkTransfer: vi.fn(),
}));

async function connect() {
  const server = new McpServer({ name: 'budget-transfers-test', version: '1.0.0' });
  registerTransferTools(server, { db: {} as never });
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

describe('MCP transfer tools', () => {
  it('registers both tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('find_transfer_candidates');
    expect(names).toContain('link_transfer');
  });

  it('find_transfer_candidates forwards options and returns pairs', async () => {
    vi.mocked(findTransferCandidates).mockResolvedValueOnce([{ confidence: 'unique' }] as never);
    const client = await connect();
    const res = await client.callTool({
      name: 'find_transfer_candidates',
      arguments: { accountId: 'acc-1', daysWindow: 2, sinceDate: '2026-09-01' },
    });
    expect(findTransferCandidates).toHaveBeenCalledWith({
      accountId: 'acc-1',
      daysWindow: 2,
      sinceDate: '2026-09-01',
    });
    expect(JSON.parse(textOf(res as never))).toEqual([{ confidence: 'unique' }]);
  });

  it('link_transfer defaults to dryRun=true', async () => {
    vi.mocked(linkTransfer).mockResolvedValueOnce({ dryRun: true, linked: false } as never);
    const client = await connect();
    const res = await client.callTool({ name: 'link_transfer', arguments: { txIdA: 'a', txIdB: 'b' } });
    expect(linkTransfer).toHaveBeenCalledWith('a', 'b', true, { allowReconciled: false });
    expect(JSON.parse(textOf(res as never))).toEqual({ dryRun: true, linked: false });
  });

  it('link_transfer passes dryRun=false through', async () => {
    vi.mocked(linkTransfer).mockResolvedValueOnce({ dryRun: false, linked: true } as never);
    const client = await connect();
    await client.callTool({ name: 'link_transfer', arguments: { txIdA: 'a', txIdB: 'b', dryRun: false } });
    expect(linkTransfer).toHaveBeenCalledWith('a', 'b', false, { allowReconciled: false });
  });

  it('link_transfer passes allowReconciled=true through', async () => {
    vi.mocked(linkTransfer).mockResolvedValueOnce({ dryRun: false, linked: true } as never);
    const client = await connect();
    await client.callTool({
      name: 'link_transfer',
      arguments: { txIdA: 'a', txIdB: 'b', dryRun: false, allowReconciled: true },
    });
    expect(linkTransfer).toHaveBeenCalledWith('a', 'b', false, { allowReconciled: true });
  });

  it('link_transfer returns validation errors verbatim', async () => {
    vi.mocked(linkTransfer).mockRejectedValueOnce(new TransferLinkError('Transactions are in the same account'));
    const client = await connect();
    const res = await client.callTool({ name: 'link_transfer', arguments: { txIdA: 'a', txIdB: 'b' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toBe('Transactions are in the same account');
  });

  it('link_transfer wraps unexpected errors', async () => {
    vi.mocked(linkTransfer).mockRejectedValueOnce(new Error('boom'));
    const client = await connect();
    const res = await client.callTool({ name: 'link_transfer', arguments: { txIdA: 'a', txIdB: 'b' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('Actual Budget write failed: boom');
  });
});
