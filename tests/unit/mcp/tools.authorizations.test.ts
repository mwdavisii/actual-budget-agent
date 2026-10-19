import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuthorizationTools } from '../../../src/mcp/tools/authorizations';
import {
  findSupersededAuthorizations,
  resolveSupersededAuthorization,
  AuthorizationResolveError,
} from '../../../src/actual/authorizations';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/authorizations', async (orig) => ({
  ...(await orig<typeof import('../../../src/actual/authorizations')>()),
  findSupersededAuthorizations: vi.fn(),
  resolveSupersededAuthorization: vi.fn(),
}));

async function connect() {
  const server = new McpServer({ name: 'budget-auth-test', version: '1.0.0' });
  registerAuthorizationTools(server, { db: {} as never });
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

describe('MCP authorization tools', () => {
  it('registers both tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('find_superseded_authorizations');
    expect(names).toContain('resolve_superseded_authorization');
  });

  it('find forwards options and returns pairs', async () => {
    vi.mocked(findSupersededAuthorizations).mockResolvedValueOnce([{ confidence: 'unique' }] as never);
    const client = await connect();
    const res = await client.callTool({
      name: 'find_superseded_authorizations',
      arguments: { accountId: 'a', daysWindow: 3, maxTipPercent: 40, sinceDate: '2026-09-01' },
    });
    expect(findSupersededAuthorizations).toHaveBeenCalledWith({
      accountId: 'a', daysWindow: 3, maxTipPercent: 40, sinceDate: '2026-09-01',
    });
    expect(JSON.parse(textOf(res as never))).toEqual([{ confidence: 'unique' }]);
  });

  it('find rejects a malformed sinceDate', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: 'find_superseded_authorizations',
      arguments: { sinceDate: 'yesterday' },
    });
    expect(res.isError).toBe(true);
    expect(findSupersededAuthorizations).not.toHaveBeenCalled();
  });

  it('resolve defaults to dryRun:true', async () => {
    vi.mocked(resolveSupersededAuthorization).mockResolvedValueOnce({ dryRun: true } as never);
    const client = await connect();
    await client.callTool({
      name: 'resolve_superseded_authorization',
      arguments: { pendingTxId: 'p', finalTxId: 'f' },
    });
    expect(resolveSupersededAuthorization).toHaveBeenCalledWith('p', 'f', true);
  });

  it('resolve passes dryRun:false through', async () => {
    vi.mocked(resolveSupersededAuthorization).mockResolvedValueOnce({ dryRun: false } as never);
    const client = await connect();
    await client.callTool({
      name: 'resolve_superseded_authorization',
      arguments: { pendingTxId: 'p', finalTxId: 'f', dryRun: false },
    });
    expect(resolveSupersededAuthorization).toHaveBeenCalledWith('p', 'f', false);
  });

  it('returns validation errors verbatim and wraps other failures', async () => {
    vi.mocked(resolveSupersededAuthorization)
      .mockRejectedValueOnce(new AuthorizationResolveError('Transactions must have the same payee'))
      .mockRejectedValueOnce(new Error('db exploded'));
    const client = await connect();
    const args = { pendingTxId: 'p', finalTxId: 'f' };
    const a = await client.callTool({ name: 'resolve_superseded_authorization', arguments: args });
    expect(a.isError).toBe(true);
    expect(textOf(a as never)).toBe('Transactions must have the same payee');
    const b = await client.callTool({ name: 'resolve_superseded_authorization', arguments: args });
    expect(textOf(b as never)).toBe('Actual Budget write failed: db exploded');
  });
});
