import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateRuleInput,
  humanizeRule,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  explainTransaction,
  runRules,
  type RuleInput,
} from '../../../src/actual/rules';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => {
  const chain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  return {
    actualApi: {
      getRules: vi.fn(),
      createRule: vi.fn(),
      updateRule: vi.fn(),
      deleteRule: vi.fn(),
      updateTransaction: vi.fn(),
      getPayees: vi.fn(),
      getCategoryGroups: vi.fn(),
      runQuery: vi.fn(),
      q: vi.fn(() => chain),
    },
  };
});

beforeEach(() => vi.clearAllMocks());

const payeeRefs = { p1: 'ST. JUDE', p2: 'AMAZON' };
const categoryRefs = { c1: 'Dining Out', c2: 'Groceries' };

describe('validateRuleInput', () => {
  it('accepts a valid rule with supported fields and ops', () => {
    const input: RuleInput = {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'is', value: 'p1' },
        { field: 'amount', op: 'gt', value: 1000 },
      ],
      actions: [{ op: 'set', field: 'category', value: 'c1' }],
    };
    expect(() => validateRuleInput(input)).not.toThrow();
  });

  it('throws with the allowed list for an unknown condition field', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'colour', op: 'is', value: 'red' }],
      actions: [],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown condition field "colour"/);
    expect(() => validateRuleInput(input)).toThrow(/account, payee, payee_name, category, notes, amount, date, cleared, imported_payee/);
  });

  it('throws with the allowed list for an unknown op on a known field', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'amount', op: 'matches', value: 'x' }],
      actions: [],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown condition op "matches" for field "amount"/);
  });

  it('rejects matches on id fields (account/payee/category)', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'matches', value: 'x' }],
      actions: [],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown condition op "matches" for field "payee"/);
  });

  it('rejects isbetween on date', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'date', op: 'isbetween', value: { num1: 1, num2: 2 } }],
      actions: [],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown condition op "isbetween" for field "date"/);
  });

  it('rejects an unknown action op', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [],
      actions: [{ op: 'delete-transaction', value: 'x' }],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown action op "delete-transaction"/);
  });

  it('rejects a set action on an unsupported field', () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [],
      actions: [{ op: 'set', field: 'amount', value: 5 }],
    };
    expect(() => validateRuleInput(input)).toThrow(/Unknown action field "amount"/);
  });
});

describe('humanizeRule', () => {
  it('renders IF/THEN with human-readable names', () => {
    const rule = {
      id: 'r1',
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
      conditions: [
        { field: 'payee', op: 'is', value: 'p1' },
        { field: 'amount', op: 'gt', value: 1000 },
      ],
      actions: [{ op: 'set', field: 'category', value: 'c1' }],
    };
    const text = humanizeRule(rule, { payees: payeeRefs, categories: categoryRefs });
    expect(text).toContain('IF');
    expect(text).toContain('THEN');
    expect(text).toContain('ST. JUDE');
    expect(text).toContain('Dining Out');
    expect(text).toContain('AND');
  });
});

describe('native CRUD passthrough', () => {
  it('listRules returns getRules result', async () => {
    (actualApi.getRules as any).mockResolvedValue([{ id: 'r1', stage: 'pre' }]);
    const result = await listRules();
    expect(result).toEqual([{ id: 'r1', stage: 'pre' }]);
    expect(actualApi.getRules).toHaveBeenCalledTimes(1);
  });

  it('createRule validates then calls createRule', async () => {
    (actualApi.createRule as any).mockResolvedValue({ id: 'r9' });
    const input: RuleInput = {
      stage: 'post',
      conditionsOp: 'or',
      conditions: [{ field: 'notes', op: 'contains', value: 'amazon' }],
      actions: [{ op: 'append-notes', value: ' reviewed' }],
    };
    const result = await createRule(input);
    expect(result).toEqual({ id: 'r9' });
    expect(actualApi.createRule).toHaveBeenCalledWith(expect.objectContaining({ stage: 'post' }));
  });

  it('createRule surfaces allowed fields on invalid input', async () => {
    const input: RuleInput = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'bogus', op: 'is', value: 'x' }],
      actions: [],
    };
    await expect(createRule(input)).rejects.toThrow(/Unknown condition field "bogus"/);
    expect(actualApi.createRule).not.toHaveBeenCalled();
  });

  it('updateRule and deleteRule pass through', async () => {
    (actualApi.updateRule as any).mockResolvedValue({ id: 'r1' });
    (actualApi.deleteRule as any).mockResolvedValue(true);
    await updateRule('r1', { stage: 'pre', conditionsOp: 'and', conditions: [], actions: [] });
    expect(actualApi.updateRule).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
    await deleteRule('r1');
    expect(actualApi.deleteRule).toHaveBeenCalledWith('r1');
  });
});

describe('explainTransaction', () => {
  it('applies rules in pre→null→post order with later rule overriding earlier category', async () => {
    (actualApi.getRules as any).mockResolvedValue([
      { id: 'r3', stage: 'post', conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p1' }], actions: [{ op: 'set', field: 'category', value: 'Groceries' }] },
      { id: 'r1', stage: 'pre', conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p1' }], actions: [{ op: 'set', field: 'category', value: 'Dining Out' }] },
      { id: 'r2', stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p1' }], actions: [{ op: 'set', field: 'category', value: 'Dining Out' }] },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [{ id: 't1', date: '2026-06-22', amount: 1000, payee: 'p1', category: null, notes: '', account: 'a1', cleared: false }],
    });
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { categories: [{ id: 'c1', name: 'Dining Out' }, { id: 'c2', name: 'Groceries' }] },
    ]);

    const result = await explainTransaction('t1');

    expect(result.txId).toBe('t1');
    expect(result.category).toBe('c2');
    expect(result.categoryName).toBe('Groceries');
    expect(result.firedRuleIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('throws when the transaction is not found', async () => {
    (actualApi.getRules as any).mockResolvedValue([]);
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });
    await expect(explainTransaction('missing')).rejects.toThrow(/Transaction missing not found/);
  });
});

describe('runRules', () => {
  it('dry-run true with mixed supported/unsupported actions makes zero updateTransaction calls and reports skips', async () => {
    (actualApi.getRules as any).mockResolvedValue([
      {
        id: 'r1',
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'p1' }],
        actions: [
          { op: 'set', field: 'category', value: 'Dining Out' },
          { op: 'set-split-amount', value: 5 },
        ],
      },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [{ id: 't1', date: '2026-06-22', amount: 1000, payee: 'p1', category: null, notes: '', account: 'a1', cleared: false }],
    });
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { categories: [{ id: 'c1', name: 'Dining Out' }] },
    ]);

    const result = await runRules({ txIds: ['t1'] }, true);

    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].skippedActions).toHaveLength(1);
    expect(result.transactions[0].skippedActions[0]).toMatch(/set-split-amount/);
  });

  it('dry-run false applies supported actions via updateTransaction', async () => {
    (actualApi.getRules as any).mockResolvedValue([
      {
        id: 'r1',
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'p1' }],
        actions: [{ op: 'set', field: 'category', value: 'Dining Out' }],
      },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [{ id: 't1', date: '2026-06-22', amount: 1000, payee: 'p1', category: null, notes: '', account: 'a1', cleared: false }],
    });
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { categories: [{ id: 'c1', name: 'Dining Out' }] },
    ]);
    (actualApi.updateTransaction as any).mockResolvedValue([]);

    const result = await runRules({ txIds: ['t1'] }, false);

    expect(actualApi.updateTransaction).toHaveBeenCalledWith('t1', { category: 'c1' });
    expect(result.transactions[0].category).toBe('c1');
  });
});
