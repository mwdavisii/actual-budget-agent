import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSetBudgetTools } from '../../../src/mcp/tools/budgets';
import { setBudgetsByMode } from '../../../src/actual/budgets';

vi.mock('../../../src/actual/client', () => ({
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/budgets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/actual/budgets')>();
  return {
    ...actual,
    setBudgetsByMode: vi.fn(),
  };
});

async function connect() {
  const server = new McpServer({ name: 'budget-set-budgets-test', version: '1.0.0' });
  registerSetBudgetTools(server, { db: {} as never });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return client;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

const PROJECTION = {
  dryRun: true,
  month: '2026-06',
  mode: 'copy_last_month',
  includeIncome: false,
  categoryCount: 1,
  categories: [
    { id: 'c1', name: 'Groceries', isIncome: false, oldBudgeted: 1000, newBudgeted: 2000 },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('MCP set_budgets tool', () => {
  it('registers set_budgets with the expected schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'set_budgets');
    expect(tool).toBeDefined();

    const schema = tool?.inputSchema as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(schema.properties?.mode?.enum).toEqual([
      'copy_last_month',
      'three_month_average',
      'custom_amount',
    ]);
    expect(schema.properties?.dryRun).toBeDefined();
    expect(schema.properties?.includeIncome).toBeDefined();
    expect(schema.properties?.amount).toBeDefined();
    expect(schema.properties?.category).toBeDefined();
    expect(schema.properties?.month).toBeDefined();
    expect(schema.required).toContain('mode');
    expect(schema.required).not.toContain('dryRun');
  });

  it('defaults to a dry run and forwards the projection arguments', async () => {
    vi.mocked(setBudgetsByMode).mockResolvedValueOnce(PROJECTION as never);
    const client = await connect();

    const res = await client.callTool({ name: 'set_budgets', arguments: { mode: 'copy_last_month' } });

    expect(setBudgetsByMode).toHaveBeenCalledWith({
      month: undefined,
      mode: 'copy_last_month',
      category: undefined,
      amount: undefined,
      includeIncome: false,
      dryRun: true,
    });
    expect(JSON.parse(textOf(res as never))).toEqual(PROJECTION);
    expect((res as { isError?: boolean }).isError).not.toBe(true);
  });

  it('passes dryRun:false and explicit options through', async () => {
    vi.mocked(setBudgetsByMode).mockResolvedValueOnce({ ...PROJECTION, dryRun: false } as never);
    const client = await connect();

    await client.callTool({
      name: 'set_budgets',
      arguments: {
        month: '2026-05',
        mode: 'custom_amount',
        category: 'Groceries',
        amount: 5000,
        includeIncome: true,
        dryRun: false,
      },
    });

    expect(setBudgetsByMode).toHaveBeenCalledWith({
      month: '2026-05',
      mode: 'custom_amount',
      category: 'Groceries',
      amount: 5000,
      includeIncome: true,
      dryRun: false,
    });
  });

  it('rejects a malformed month at the schema layer', async () => {
    const client = await connect();

    const res = await client.callTool({
      name: 'set_budgets',
      arguments: { month: '2026-6', mode: 'copy_last_month' },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(setBudgetsByMode).not.toHaveBeenCalled();
  });

  it('surfaces core validation errors verbatim', async () => {
    vi.mocked(setBudgetsByMode).mockRejectedValueOnce(
      new Error('amount is required as an integer number of cents for mode "custom_amount"')
    );
    const client = await connect();

    const res = await client.callTool({
      name: 'set_budgets',
      arguments: { mode: 'custom_amount' },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/amount is required/);
  });
});
