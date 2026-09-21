import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRulesTools } from '../../../src/mcp/tools/rules';

vi.mock('../../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../../src/actual/rules', () => ({
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  explainTransaction: vi.fn(),
  runRules: vi.fn(),
  humanizeRule: vi.fn((rule) => `IF ${rule.id} THEN action`),
  buildRefs: vi.fn().mockResolvedValue({ payees: {}, categories: {} }),
}));

async function connectRulesToolsClient() {
  const server = new McpServer({ name: 'budget-rules-test', version: '1.0.0' });
  registerRulesTools(server, { db: {} as never });
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

describe('MCP rules tools', () => {
  it('lists all six rules tools', async () => {
    const client = await connectRulesToolsClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'list_rules',
      'create_rule',
      'update_rule',
      'delete_rule',
      'explain_transaction',
      'run_rules',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('list_rules returns a humanized array that includes raw conditions and actions', async () => {
    const { listRules, humanizeRule } = await import('../../../src/actual/rules');
    const rule = {
      id: 'rule-1',
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
      conditions: [{ field: 'payee_name', op: 'contains', value: 'Starbucks' }],
      actions: [{ op: 'set' as const, field: 'category', value: 'Dining' }],
    };
    (listRules as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce([rule]);

    const client = await connectRulesToolsClient();
    const res = await client.callTool({ name: 'list_rules', arguments: {} });
    const parsed = JSON.parse(textOf(res as never));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('rule-1');
    expect(parsed[0].conditions).toEqual(rule.conditions);
    expect(parsed[0].actions).toEqual(rule.actions);
    expect(parsed[0].text).toBe('IF rule-1 THEN action');
    expect(humanizeRule).toHaveBeenCalledWith(rule, { payees: {}, categories: {} });
  });

  it('create_rule returns success with ruleId and humanized text', async () => {
    const { createRule, humanizeRule } = await import('../../../src/actual/rules');
    const rule = {
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
      conditions: [{ field: 'payee_name', op: 'contains', value: 'Starbucks' }],
      actions: [{ op: 'set' as const, field: 'category', value: 'Dining' }],
    };
    (createRule as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ id: 'new-rule' });

    const client = await connectRulesToolsClient();
    const res = await client.callTool({ name: 'create_rule', arguments: { rule } });
    const parsed = JSON.parse(textOf(res as never));
    expect(parsed).toEqual({ success: true, ruleId: 'new-rule', text: 'IF new-rule THEN action' });
    expect(createRule).toHaveBeenCalledWith(rule);
    expect(humanizeRule).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-rule', ...rule }), {
      payees: {},
      categories: {},
    });
  });

  it('create_rule validation error surfaces allowed fields as a tool error', async () => {
    const { createRule } = await import('../../../src/actual/rules');
    (createRule as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('Unknown condition field "colour" — allowed: account, payee, payee_name, category, notes, amount, date, cleared, imported_payee')
    );

    const client = await connectRulesToolsClient();
    const res = await client.callTool({
      name: 'create_rule',
      arguments: {
        rule: {
          stage: null,
          conditionsOp: 'and',
          conditions: [{ field: 'colour', op: 'is', value: 'red' }],
          actions: [],
        },
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('Unknown condition field "colour"');
    expect(textOf(res as never)).toContain('allowed:');
  });

  it('update_rule returns success with ruleId and humanized text', async () => {
    const { updateRule, humanizeRule } = await import('../../../src/actual/rules');
    const rule = {
      stage: 'post' as const,
      conditionsOp: 'or' as const,
      conditions: [{ field: 'notes', op: 'contains', value: 'reimburse' }],
      actions: [{ op: 'append-notes' as const, value: ' [reviewed]' }],
    };
    (updateRule as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ id: 'rule-2' });

    const client = await connectRulesToolsClient();
    const res = await client.callTool({ name: 'update_rule', arguments: { ruleId: 'rule-2', rule } });
    const parsed = JSON.parse(textOf(res as never));
    expect(parsed).toEqual({ success: true, ruleId: 'rule-2', text: 'IF rule-2 THEN action' });
    expect(updateRule).toHaveBeenCalledWith('rule-2', rule);
    expect(humanizeRule).toHaveBeenCalledWith(expect.objectContaining({ id: 'rule-2', ...rule }), {
      payees: {},
      categories: {},
    });
  });

  it('delete_rule returns success and deleted flag for a single id', async () => {
    const { deleteRule } = await import('../../../src/actual/rules');
    (deleteRule as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(true);

    const client = await connectRulesToolsClient();
    const res = await client.callTool({ name: 'delete_rule', arguments: { ruleId: 'rule-3' } });
    const parsed = JSON.parse(textOf(res as never));
    expect(parsed).toEqual({ success: true, deleted: true });
    expect(deleteRule).toHaveBeenCalledWith('rule-3');
  });

  it('explain_transaction returns the mocked explain result', async () => {
    const { explainTransaction } = await import('../../../src/actual/rules');
    const mocked = {
      txId: 'tx-1',
      firedRuleIds: ['rule-a'],
      category: 'cat-dining',
      categoryName: 'Dining',
      payee: 'payee-starbucks',
      payeeName: 'Starbucks',
      cleared: true,
      notes: null,
    };
    (explainTransaction as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectRulesToolsClient();
    const res = await client.callTool({ name: 'explain_transaction', arguments: { txId: 'tx-1' } });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(explainTransaction).toHaveBeenCalledWith('tx-1');
  });

  it('run_rules defaults to dryRun=true', async () => {
    const { runRules } = await import('../../../src/actual/rules');
    const mocked = { dryRun: true, transactions: [] };
    (runRules as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectRulesToolsClient();
    const res = await client.callTool({
      name: 'run_rules',
      arguments: { scope: { all: true } },
    });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(runRules).toHaveBeenCalledWith({ all: true }, true);
  });

  it('run_rules passes explicit dryRun=false through', async () => {
    const { runRules } = await import('../../../src/actual/rules');
    const mocked = { dryRun: false, transactions: [{ txId: 'tx-1', firedRuleIds: ['rule-a'], skippedActions: [] }] };
    (runRules as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(mocked);

    const client = await connectRulesToolsClient();
    const res = await client.callTool({
      name: 'run_rules',
      arguments: { scope: { txIds: ['tx-1'] }, dryRun: false },
    });
    expect(JSON.parse(textOf(res as never))).toEqual(mocked);
    expect(runRules).toHaveBeenCalledWith({ txIds: ['tx-1'] }, false);
  });

  it('surfaces a mocked upstream failure as an Actual Budget write failed tool error', async () => {
    const { runRules } = await import('../../../src/actual/rules');
    (runRules as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('actual unreachable')
    );

    const client = await connectRulesToolsClient();
    const res = await client.callTool({
      name: 'run_rules',
      arguments: { scope: { accountId: 'acc-1' } },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toMatch(/Actual Budget write failed/i);
  });
});
