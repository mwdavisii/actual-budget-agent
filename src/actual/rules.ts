import { actualApi } from './client';
import { resolveCategory, resolvePayee } from './naming';

// ── Types ────────────────────────────────────────────────────────────────────

export type RuleStage = 'pre' | 'post' | null;

export interface RuleCondition {
  field: string;
  op: string;
  value: unknown;
  options?: {
    inflow?: boolean;
    outflow?: boolean;
    month?: boolean;
    year?: boolean;
  };
}

export interface RuleAction {
  op: 'set' | 'prepend-notes' | 'append-notes';
  field?: string;
  value: unknown;
}

export interface RuleInput {
  stage: RuleStage;
  conditionsOp: 'and' | 'or';
  conditions: RuleCondition[];
  actions: RuleAction[];
}

// The native rule entity shape returned by getRules() (RuleEntity from core).
export interface RuleEntity {
  id: string;
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
  conditions: RuleCondition[];
  actions: Array<{ op: string; field?: string; value: unknown }>;
}

// ── Validation ───────────────────────────────────────────────────────────────

const CONDITION_FIELDS = [
  'account',
  'payee',
  'payee_name',
  'category',
  'notes',
  'amount',
  'date',
  'cleared',
  'imported_payee',
] as const;

// Ops allowed per field. Kept aligned with the evaluator: `matches` is NOT
// supported on id fields (account/payee/category) by the evaluator, so it is
// rejected here too. `date` has no `isbetween` (TYPE_INFO.date.ops omits it).
const FIELD_OPS: Record<string, string[]> = {
  account: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain'],
  payee: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain'],
  category: ['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain'],
  payee_name: ['is', 'isNot', 'contains', 'doesNotContain', 'matches'],
  notes: ['is', 'isNot', 'contains', 'doesNotContain', 'matches'],
  imported_payee: ['is', 'isNot', 'contains', 'doesNotContain', 'matches'],
  amount: ['is', 'isapprox', 'isbetween', 'gt', 'gte', 'lt', 'lte'],
  date: ['is', 'isapprox', 'gt', 'gte', 'lt', 'lte'],
  cleared: ['is'],
};

const SET_ACTION_FIELDS = ['category', 'payee', 'cleared', 'notes'] as const;

export function validateRuleInput(input: RuleInput): void {
  for (const cond of input.conditions) {
    if (!CONDITION_FIELDS.includes(cond.field as (typeof CONDITION_FIELDS)[number])) {
      throw new Error(
        `Unknown condition field "${cond.field}" — allowed: ${CONDITION_FIELDS.join(', ')}`
      );
    }
    const allowedOps = FIELD_OPS[cond.field];
    if (!allowedOps.includes(cond.op)) {
      throw new Error(
        `Unknown condition op "${cond.op}" for field "${cond.field}" — allowed: ${allowedOps.join(', ')}`
      );
    }
  }

  for (const action of input.actions) {
    if (action.op === 'set') {
      if (!action.field || !SET_ACTION_FIELDS.includes(action.field as (typeof SET_ACTION_FIELDS)[number])) {
        throw new Error(
          `Unknown action field "${action.field}" — allowed: ${SET_ACTION_FIELDS.join(', ')}`
        );
      }
    } else if (action.op !== 'prepend-notes' && action.op !== 'append-notes') {
      throw new Error(
        `Unknown action op "${action.op}" — allowed: set, prepend-notes, append-notes`
      );
    }
  }
}

// ── Humanized rendering ──────────────────────────────────────────────────────

export interface RuleRefs {
  payees: Record<string, string>;
  categories: Record<string, string>;
}

function humanizeValue(field: string, value: unknown, refs: RuleRefs): string {
  if (field === 'payee' && typeof value === 'string' && refs.payees[value]) {
    return refs.payees[value];
  }
  if (field === 'category' && typeof value === 'string' && refs.categories[value]) {
    return refs.categories[value];
  }
  if (Array.isArray(value)) return value.join(', ');
  if (value === null) return '(none)';
  return String(value);
}

export function humanizeRule(rule: RuleEntity, refs: RuleRefs): string {
  const stagePrefix = rule.stage ? `[${rule.stage}] ` : '';
  const condText = rule.conditions
    .map((c) => `${c.field} ${c.op} ${humanizeValue(c.field, c.value, refs)}`)
    .join(` ${rule.conditionsOp.toUpperCase()} `);
  const actionText = rule.actions
    .map((a) => {
      if (a.op === 'set') return `set ${a.field} ${humanizeValue(a.field ?? '', a.value, refs)}`;
      return `${a.op} ${String(a.value)}`;
    })
    .join('; ');
  return `IF ${stagePrefix}(${condText}) THEN (${actionText})`;
}

// ── Native CRUD passthrough ──────────────────────────────────────────────────

export async function listRules(): Promise<RuleEntity[]> {
  return (await actualApi.getRules()) as RuleEntity[];
}

export async function createRule(rule: RuleInput): Promise<{ id: string }> {
  validateRuleInput(rule);
  return (await actualApi.createRule(rule as unknown as Parameters<typeof actualApi.createRule>[0])) as {
    id: string;
  };
}

export async function updateRule(ruleId: string, rule: RuleInput): Promise<{ id: string }> {
  validateRuleInput(rule);
  return (await actualApi.updateRule({ id: ruleId, ...rule } as unknown as Parameters<
    typeof actualApi.updateRule
  >[0])) as { id: string };
}

export async function deleteRule(ruleId: string): Promise<boolean> {
  return actualApi.deleteRule(ruleId);
}

// ── Evaluator ────────────────────────────────────────────────────────────────

interface TxRow {
  id: string;
  date: string;
  amount: number;
  payee: string | null;
  category: string | null;
  notes: string | null;
  account: string;
  cleared: boolean;
  imported_payee?: string | null;
}

interface Projection {
  category: string | null;
  payee: string | null;
  cleared: boolean;
  notes: string | null;
}

function rankRules(rules: RuleEntity[]): RuleEntity[] {
  const pre: RuleEntity[] = [];
  const normal: RuleEntity[] = [];
  const post: RuleEntity[] = [];
  for (const rule of rules) {
    if (rule.stage === 'pre') pre.push(rule);
    else if (rule.stage === 'post') post.push(rule);
    else normal.push(rule);
  }
  const byId = (a: RuleEntity, b: RuleEntity) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  pre.sort(byId);
  normal.sort(byId);
  post.sort(byId);
  return pre.concat(normal).concat(post);
}

function approxMatches(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.round(Math.abs(expected) * 0.075);
}

function conditionMatches(cond: RuleCondition, tx: TxRow): boolean {
  const { field, op, value } = cond;
  let actual: unknown;
  switch (field) {
    case 'account':
      actual = tx.account;
      break;
    case 'payee':
      actual = tx.payee;
      break;
    case 'payee_name':
      actual = tx.payee;
      break;
    case 'category':
      actual = tx.category;
      break;
    case 'notes':
      actual = tx.notes ?? '';
      break;
    case 'amount':
      actual = tx.amount;
      break;
    case 'date':
      actual = tx.date;
      break;
    case 'cleared':
      actual = tx.cleared;
      break;
    case 'imported_payee':
      actual = tx.imported_payee ?? '';
      break;
    default:
      return false;
  }

  switch (op) {
    case 'is':
      return actual === value;
    case 'isNot':
      return actual !== value;
    case 'oneOf':
      return Array.isArray(value) && value.includes(actual);
    case 'notOneOf':
      return Array.isArray(value) && !value.includes(actual);
    case 'contains':
      return typeof actual === 'string' && actual.toLowerCase().includes(String(value).toLowerCase());
    case 'doesNotContain':
      return typeof actual === 'string' && !actual.toLowerCase().includes(String(value).toLowerCase());
    case 'matches':
      try {
        return new RegExp(String(value), 'i').test(String(actual));
      } catch {
        return false;
      }
    case 'gt':
      return (actual as number) > (value as number);
    case 'gte':
      return (actual as number) >= (value as number);
    case 'lt':
      return (actual as number) < (value as number);
    case 'lte':
      return (actual as number) <= (value as number);
    case 'isapprox':
      return approxMatches(actual as number, value as number);
    case 'isbetween': {
      const v = value as { num1: number; num2: number };
      const low = Math.min(v.num1, v.num2);
      const high = Math.max(v.num1, v.num2);
      return (actual as number) >= low && (actual as number) <= high;
    }
    default:
      return false;
  }
}

function ruleMatches(rule: RuleEntity, tx: TxRow): boolean {
  if (rule.conditions.length === 0) return true;
  const results = rule.conditions.map((c) => conditionMatches(c, tx));
  return rule.conditionsOp === 'and' ? results.every(Boolean) : results.some(Boolean);
}

interface SkippedAction {
  op: string;
  reason: string;
}

async function resolveActionValue(
  action: { op: string; field?: string; value: unknown }
): Promise<{ value: unknown; skipped?: SkippedAction }> {
  if (action.op === 'set') {
    if (action.field === 'category') {
      if (action.value === null) return { value: null };
      const resolved = await resolveCategory(String(action.value));
      return { value: resolved.id };
    }
    if (action.field === 'payee') {
      if (action.value === null) return { value: null };
      const resolved = await resolvePayee(String(action.value));
      return { value: resolved.id };
    }
    return { value: action.value };
  }
  return { value: action.value };
}

async function applyRule(
  rule: RuleEntity,
  tx: TxRow,
  projection: Projection
): Promise<{ fired: boolean; skipped: SkippedAction[] }> {
  if (!ruleMatches(rule, tx)) return { fired: false, skipped: [] };

  const skipped: SkippedAction[] = [];
  for (const action of rule.actions) {
    if (action.op === 'set') {
      if (action.field === 'category' || action.field === 'payee' || action.field === 'cleared' || action.field === 'notes') {
        const { value, skipped: skip } = await resolveActionValue(action);
        if (skip) {
          skipped.push(skip);
          continue;
        }
        if (action.field === 'category') projection.category = value as string | null;
        else if (action.field === 'payee') projection.payee = value as string | null;
        else if (action.field === 'cleared') projection.cleared = Boolean(value);
        else if (action.field === 'notes') projection.notes = value as string | null;
      } else {
        skipped.push({ op: action.op, reason: `unsupported set field "${action.field}"` });
      }
    } else if (action.op === 'prepend-notes' || action.op === 'append-notes') {
      const current = projection.notes ?? '';
      const text = String(action.value);
      projection.notes = action.op === 'prepend-notes' ? text + current : current + text;
    } else {
      skipped.push({ op: action.op, reason: 'unsupported action' });
    }
  }

  return { fired: true, skipped };
}

async function fetchTx(txId: string): Promise<TxRow> {
  const result = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ id: txId })
      .options({ splits: 'grouped' })
      .select(['id', 'date', 'amount', 'payee', 'category', 'notes', 'account', 'cleared', 'imported_payee'])
  );
  const rows = (result as { data: TxRow[] }).data;
  if (rows.length === 0) throw new Error(`Transaction ${txId} not found`);
  return rows[0];
}

export async function buildRefs(): Promise<RuleRefs> {
  const payees = (await actualApi.getPayees()) as Array<{ id: string; name?: string }>;
  const payeeMap = Object.fromEntries(payees.map((p) => [p.id, p.name ?? '']));
  const groups = (await actualApi.getCategoryGroups()) as Array<{
    categories?: Array<{ id: string; name: string }>;
  }>;
  const categoryMap: Record<string, string> = {};
  for (const g of groups) {
    for (const c of g.categories ?? []) categoryMap[c.id] = c.name;
  }
  return { payees: payeeMap, categories: categoryMap };
}

export interface ExplainResult {
  txId: string;
  firedRuleIds: string[];
  category: string | null;
  categoryName: string | null;
  payee: string | null;
  payeeName: string | null;
  cleared: boolean;
  notes: string | null;
}

export async function explainTransaction(txId: string): Promise<ExplainResult> {
  const tx = await fetchTx(txId);
  const rules = rankRules(await listRules());
  const refs = await buildRefs();

  const projection: Projection = {
    category: tx.category,
    payee: tx.payee,
    cleared: tx.cleared,
    notes: tx.notes,
  };
  const firedRuleIds: string[] = [];

    for (const rule of rules) {
      const { fired } = await applyRule(rule, tx, projection);
      if (fired) firedRuleIds.push(rule.id);
    }

  return {
    txId,
    firedRuleIds,
    category: projection.category,
    categoryName: projection.category ? refs.categories[projection.category] ?? null : null,
    payee: projection.payee,
    payeeName: projection.payee ? refs.payees[projection.payee] ?? null : null,
    cleared: projection.cleared,
    notes: projection.notes,
  };
}

export interface RunRulesScope {
  txIds?: string[];
  accountId?: string;
  categoryId?: string;
  all?: boolean;
}

export interface RunRulesTxResult {
  txId: string;
  category: string | null;
  categoryName: string | null;
  payee: string | null;
  payeeName: string | null;
  cleared: boolean;
  notes: string | null;
  firedRuleIds: string[];
  skippedActions: string[];
}

export interface RunRulesResult {
  dryRun: boolean;
  transactions: RunRulesTxResult[];
}

async function fetchScopedTxs(scope: RunRulesScope): Promise<TxRow[]> {
  let query = actualApi
    .q('transactions')
    .options({ splits: 'grouped' })
    .select(['id', 'date', 'amount', 'payee', 'category', 'notes', 'account', 'cleared', 'imported_payee']);

  if (scope.txIds && scope.txIds.length > 0) {
    query = query.filter({ id: { $oneof: scope.txIds } });
  } else if (scope.accountId) {
    query = query.filter({ account: scope.accountId });
  } else if (scope.categoryId) {
    query = query.filter({ category: scope.categoryId });
  } else if (scope.all) {
    // no filter — whole budget
  } else {
    throw new Error('runRules requires an explicit scope: txIds, accountId, categoryId, or all:true');
  }

  const result = await actualApi.runQuery(query);
  return (result as { data: TxRow[] }).data;
}

export async function runRules(scope: RunRulesScope, dryRun = true): Promise<RunRulesResult> {
  const txs = await fetchScopedTxs(scope);
  const rules = rankRules(await listRules());
  const refs = await buildRefs();

  const transactions: RunRulesTxResult[] = [];

  for (const tx of txs) {
    const projection: Projection = {
      category: tx.category,
      payee: tx.payee,
      cleared: tx.cleared,
      notes: tx.notes,
    };
    const firedRuleIds: string[] = [];
    const skippedActions: string[] = [];

    for (const rule of rules) {
      const { fired, skipped } = await applyRule(rule, tx, projection);
      if (fired) {
        firedRuleIds.push(rule.id);
        for (const s of skipped) skippedActions.push(`${s.op}: ${s.reason}`);
      }
    }

    if (!dryRun) {
      const changed =
        projection.category !== tx.category ||
        projection.payee !== tx.payee ||
        projection.cleared !== tx.cleared ||
        projection.notes !== tx.notes;
      if (changed) {
        const fields: Record<string, unknown> = {};
        if (projection.category !== tx.category) fields.category = projection.category;
        if (projection.payee !== tx.payee) fields.payee = projection.payee;
        if (projection.cleared !== tx.cleared) fields.cleared = projection.cleared;
        if (projection.notes !== tx.notes) fields.notes = projection.notes;
        await actualApi.updateTransaction(tx.id, fields);
      }
    }

    transactions.push({
      txId: tx.id,
      category: projection.category,
      categoryName: projection.category ? refs.categories[projection.category] ?? null : null,
      payee: projection.payee,
      payeeName: projection.payee ? refs.payees[projection.payee] ?? null : null,
      cleared: projection.cleared,
      notes: projection.notes,
      firedRuleIds,
      skippedActions,
    });
  }

  return { dryRun, transactions };
}
