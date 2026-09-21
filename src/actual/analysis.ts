import { actualApi } from './client';
import { getAccounts } from './queries';
import { suggestClosest } from './naming';

export interface UnreconciledTransaction {
  id: string;
  date: string;
  amount: number;
  payee: string;
  notes: string | null;
  account: string;
  cleared: boolean;
  runningBalance: number;
}

export interface UnreconciledAccountView {
  accountId: string;
  accountName: string;
  lastReconciled: string | null;
  currentBalance: number;
  clearedBalance: number;
  unreconciledCount: number;
  transactions: UnreconciledTransaction[];
}

export interface DuplicatePayeeGroup {
  normalized: string;
  canonical: { id: string; name: string; count: number };
  duplicates: Array<{
    id: string;
    name: string;
    count: number;
    firstDate: string | null;
    lastDate: string | null;
  }>;
}

export async function getUnreconciled(accountId: string): Promise<UnreconciledAccountView> {
  const accounts = await getAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    const suggestions = suggestClosest(accountId, accounts.map((a) => a.name));
    const suffix = suggestions.length ? ` — did you mean: ${suggestions.join(', ')}?` : '';
    throw new Error(`Account "${accountId}" not found${suffix}`);
  }

  const rawAccounts = (await actualApi.getAccounts()) as Array<{
    id: string;
    last_reconciled?: string | null;
  }>;
  const lastReconciled = rawAccounts.find((a) => a.id === accountId)?.last_reconciled ?? null;

  const currentBalance = Number(await actualApi.getAccountBalance(accountId));

  const unclearedResult = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ account: accountId, cleared: false })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'payee', 'notes', 'account', 'cleared'])
  );
  const unclearedRows = ((unclearedResult as { data?: Record<string, unknown>[] }).data ?? []).map(
    (row) => ({
      id: String(row.id),
      date: String(row.date),
      amount: Number(row.amount),
      payee: row.payee == null ? '' : String(row.payee),
      notes: row.notes == null ? null : String(row.notes),
      account: String(row.account),
      cleared: Boolean(row.cleared),
    })
  );

  const sorted = [...unclearedRows].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.id.localeCompare(b.id);
  });

  let runningBalance = 0;
  const transactions = sorted.map((tx) => {
    runningBalance += tx.amount;
    return { ...tx, runningBalance };
  });

  const clearedResult = await actualApi.runQuery(
    actualApi.q('transactions').filter({ account: accountId, cleared: true }).calculate({ $sum: '$amount' })
  );
  const clearedBalance = Number((clearedResult as { data?: number }).data ?? 0);

  return {
    accountId,
    accountName: account.name,
    lastReconciled,
    currentBalance,
    clearedBalance,
    unreconciledCount: transactions.length,
    transactions,
  };
}

function normalizePayeeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function findDuplicatePayees(): Promise<DuplicatePayeeGroup[]> {
  const payees = (await actualApi.getPayees()) as Array<{
    id: string;
    name?: string;
    transfer_acct?: string | null;
  }>;

  const nonTransferPayees = payees.filter((p) => p.transfer_acct == null);

  const groups = new Map<string, string[]>();
  for (const payee of nonTransferPayees) {
    const normalized = normalizePayeeName(payee.name ?? '');
    if (normalized === '') continue;
    const ids = groups.get(normalized) ?? [];
    ids.push(payee.id);
    groups.set(normalized, ids);
  }

  const duplicateEntries = Array.from(groups.entries()).filter(([, ids]) => ids.length >= 2);
  if (duplicateEntries.length === 0) return [];

  const duplicateIds = duplicateEntries.flatMap(([, ids]) => ids);
  const statsResult = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ payee: { $oneof: duplicateIds } })
      .groupBy('payee')
      .select(['payee', { count: { $count: '$id' }, minDate: { $min: '$date' }, maxDate: { $max: '$date' } }])
  );
  const statsRows = ((statsResult as { data?: Array<Record<string, unknown>> }).data ?? []).map((row) => ({
    id: String(row.payee),
    count: Number(row.count),
    firstDate: row.minDate == null ? null : String(row.minDate),
    lastDate: row.maxDate == null ? null : String(row.maxDate),
  }));
  const statsById = new Map(statsRows.map((r) => [r.id, r]));

  const payeeById = new Map(nonTransferPayees.map((p) => [p.id, p.name ?? '']));

  return duplicateEntries.map(([normalized, ids]) => {
    const members = ids
      .map((id) =>
        ({
          ...(statsById.get(id) ?? { count: 0, firstDate: null, lastDate: null }),
          id,
          name: payeeById.get(id) ?? '',
        }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const [canonical, ...duplicates] = members;
    return {
      normalized,
      canonical: { id: canonical.id, name: canonical.name, count: canonical.count },
      duplicates,
    };
  });
}
