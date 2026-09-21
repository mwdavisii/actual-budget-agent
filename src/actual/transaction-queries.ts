import { actualApi } from './client';
import { sanitizeObject } from '../sanitize';
import type { Transaction } from './queries';

// Maps payee id -> human-readable payee name. Actual stores payee as a UUID on
// each transaction; the LLM needs the name to identify and reason about a
// transaction (e.g. when correcting an already-categorized one).
export async function getPayeeMap(): Promise<Record<string, string>> {
  const payees = (await actualApi.getPayees()) as Array<{ id: string; name?: string }>;
  return Object.fromEntries(payees.map((p) => [p.id, p.name ?? '']));
}

async function getCategoryMap(): Promise<Record<string, string>> {
  const groups = (await actualApi.getCategoryGroups()) as Array<{
    categories?: Array<{ id: string; name: string }>;
  }>;
  return Object.fromEntries(
    groups.flatMap((g) => g.categories ?? []).map((c) => [c.id, c.name])
  );
}

export interface TransactionSummary {
  totalMatching: number;
  groups: Array<{
    key: string;
    name: string;
    count: number;
    firstDate: string | null;
    lastDate: string | null;
    totalAmount: number;
  }>;
}

const ALLOWED_FIELDS = [
  'id',
  'date',
  'amount',
  'payee',
  'payeeName',
  'category',
  'categoryName',
  'notes',
  'account',
  'accountName',
  'cleared',
  'reconciled',
  'transferId',
  'importedPayee',
  'isParent',
  'parentId',
] as const;

const FIELD_TO_AQL: Record<string, string> = {
  id: 'id',
  date: 'date',
  amount: 'amount',
  payee: 'payee',
  payeeName: 'payee',
  category: 'category',
  categoryName: 'category',
  notes: 'notes',
  account: 'account',
  accountName: 'account',
  cleared: 'cleared',
  reconciled: 'reconciled',
  transferId: 'transfer_id',
  importedPayee: 'imported_payee',
  isParent: 'is_parent',
  parentId: 'parent_id',
};

function buildSelect(fields?: string[]): string[] {
  if (!fields) {
    return ['id', 'date', 'amount', 'payee', 'category', 'notes', 'account', 'cleared'];
  }
  const invalid = fields.filter((f) => !(ALLOWED_FIELDS as readonly string[]).includes(f));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown field "${invalid[0]}" — allowed: ${ALLOWED_FIELDS.join(', ')}`
    );
  }
  const aqlFields = [...new Set(fields.map((f) => FIELD_TO_AQL[f]).filter(Boolean))];
  if (!aqlFields.includes('id')) {
    aqlFields.unshift('id');
  }
  return aqlFields;
}

export async function getTransactions(filters: {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  amountMin?: number;
  amountMax?: number;
  cleared?: boolean;
  payeeId?: string;
  payeeContains?: string;
  notesContains?: string;
  limit?: number;
  offset?: number;
  orderBy?: { field: 'date' | 'amount' | 'id'; direction: 'asc' | 'desc' };
  summary?: 'payee' | 'category';
  fields?: string[];
}): Promise<Transaction[] | TransactionSummary> {
  const accounts = (await actualApi.getAccounts()) as Array<{ id: string; name?: string }>;
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.name ?? '']));
  const payeeMap = await getPayeeMap();
  const needsCategoryMap =
    filters.summary === 'category' || filters.fields?.includes('categoryName') === true;
  const categoryMap = needsCategoryMap ? await getCategoryMap() : ({} as Record<string, string>);

  let query = actualApi.q('transactions').select(buildSelect(filters.fields));
  if (filters.startDate) query = query.filter({ date: { $gte: filters.startDate } });
  if (filters.endDate) query = query.filter({ date: { $lte: filters.endDate } });
  if (filters.accountId) query = query.filter({ account: filters.accountId });
  if (filters.categoryId) query = query.filter({ category: filters.categoryId });
  if (filters.amountMin !== undefined) query = query.filter({ amount: { $gte: filters.amountMin } });
  if (filters.amountMax !== undefined) query = query.filter({ amount: { $lte: filters.amountMax } });
  if (filters.cleared !== undefined) query = query.filter({ cleared: filters.cleared });
  if (filters.payeeId) query = query.filter({ payee: filters.payeeId });
  if (filters.payeeContains) {
    const payees = (await actualApi.getPayees()) as Array<{ id: string; name?: string }>;
    const term = filters.payeeContains.toLowerCase();
    const ids = payees
      .filter((p) => (p.name ?? '').toLowerCase().includes(term))
      .map((p) => p.id);
    if (ids.length === 0) {
      return [];
    }
    query = query.filter({ payee: { $oneof: ids } });
  }
  if (filters.notesContains) {
    const escaped = filters.notesContains.replace(/[\\%?]/g, '\\$&');
    query = query.filter({ notes: { $like: `%${escaped}%` } });
  }
  if (filters.orderBy) {
    const aqlField = filters.orderBy.field === 'id' ? 'id' : filters.orderBy.field;
    query = query.orderBy({ [aqlField]: filters.orderBy.direction });
  }
  if (filters.limit !== undefined) query = query.limit(filters.limit);
  if (filters.offset !== undefined) query = query.offset(filters.offset);

  if (filters.summary) {
    const summaryField = filters.summary === 'payee' ? 'payee' : 'category';
    const nameMap = filters.summary === 'payee' ? payeeMap : categoryMap;

    const totalResult = await actualApi.runQuery(query.calculate({ $sum: '$amount' }));
    const totalMatching = Number((totalResult as { data?: number }).data ?? 0);

    const countResult = await actualApi.runQuery(
      query.groupBy(summaryField).select([summaryField, { count: { $count: '$id' } }])
    );
    const countRows = (countResult as { data: Array<Record<string, unknown>> }).data;

    const detailResult = await actualApi.runQuery(
      query.select([summaryField, 'date', 'amount'])
    );
    const detailRows = (detailResult as { data: Array<Record<string, unknown>> }).data;

    const groups = countRows.map((row) => {
      const key = row[summaryField] as string;
      const groupRows = detailRows.filter((r) => (r[summaryField] as string) === key);
      const dates = groupRows.map((r) => String(r.date)).sort();
      const totalAmount = groupRows.reduce((sum, r) => sum + Number(r.amount), 0);
      return {
        key,
        name: nameMap[key] ?? '',
        count: Number(row.count),
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
        totalAmount,
      };
    });

    return { totalMatching, groups };
  }

  const result = await actualApi.runQuery(query);
  return (result as { data: Record<string, unknown>[] }).data.map((tx) =>
    enrichTransaction(tx, accountMap, payeeMap, categoryMap, {
      includeCategoryName: filters.fields?.includes('categoryName') ?? false,
    })
  );
}

export function enrichTransaction(
  tx: Record<string, unknown>,
  accountMap: Record<string, string>,
  payeeMap: Record<string, string>,
  categoryMap: Record<string, string>,
  options?: { includeCategoryName?: boolean }
): Transaction {
  const sanitized = sanitizeObject(tx) as Record<string, unknown>;
  sanitized.accountName = accountMap[tx['account'] as string] ?? '';
  sanitized.payeeName = payeeMap[tx['payee'] as string] ?? '';
  if (options?.includeCategoryName) {
    sanitized.categoryName = categoryMap[tx['category'] as string] ?? null;
  }
  sanitized.cleared = Boolean(tx['cleared']);
  return sanitized as unknown as Transaction;
}

export async function getTransactionById(txId: string): Promise<Transaction | null> {
  const accounts = (await actualApi.getAccounts()) as Array<{ id: string; name?: string }>;
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.name ?? '']));
  const payeeMap = await getPayeeMap();
  const categoryMap = await getCategoryMap();

  const result = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({ id: txId })
      .select('*')
      .options({ splits: 'grouped' })
  );
  const rows = (result as { data: Record<string, unknown>[] }).data;
  if (rows.length === 0) {
    return null;
  }

  return enrichTransaction(rows[0], accountMap, payeeMap, categoryMap, {
    includeCategoryName: true,
  });
}

export async function getPayeesWithCounts(): Promise<
  Array<{ id: string; name: string; txCount: number; isTransfer: boolean }>
> {
  const payees = (await actualApi.getPayees()) as Array<{
    id: string;
    name?: string;
    transfer_acct?: string | null;
  }>;
  const ids = payees.map((p) => p.id);

  let countMap: Record<string, number> = {};
  if (ids.length > 0) {
    const countResult = await actualApi.runQuery(
      actualApi.q('transactions')
        .filter({ payee: { $oneof: ids } })
        .groupBy('payee')
        .select(['payee', { count: { $count: '$id' } }])
    );
    const countRows = (countResult as { data: Array<{ payee: string; count: number }> }).data;
    countMap = Object.fromEntries(countRows.map((r) => [r.payee, r.count]));
  }

  return payees.map((p) => ({
    id: p.id,
    name: p.name ?? '',
    txCount: countMap[p.id] ?? 0,
    isTransfer: p.transfer_acct != null,
  }));
}
