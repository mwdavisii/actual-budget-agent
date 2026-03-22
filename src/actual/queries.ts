import { actualApi } from './client';
import { sanitizeObject } from '../sanitize';

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  payee: string;
  category: string | null;
  notes: string | null;
  account: string;
  accountName: string;
}

export interface CategoryStatus {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  available: number;
  isIncome: boolean;
}

export interface ScheduledTransaction {
  id: string;
  payee: string;
  amount: number;
  nextDate: string;
  category: string | null;
}

export async function getUncategorizedTransactions(): Promise<Transaction[]> {
  const accounts = await actualApi.getAccounts() as Array<{ id: string; closed: boolean; offbudget: boolean }>;
  const onBudgetIds = accounts.filter((a) => !a.closed && !a.offbudget).map((a) => a.id);

  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, (a as any).name as string]));

  const result = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({
        category: null,
        transfer_id: null,
        account: { $oneof: onBudgetIds },
      })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'payee', 'notes', 'account'])
  );
  return (result as { data: Record<string, unknown>[] }).data.map((tx) => {
    const sanitized = sanitizeObject(tx) as Record<string, unknown>;
    sanitized.accountName = accountMap[tx['account'] as string] ?? '';
    return sanitized as unknown as Transaction;
  });
}

export async function getTransactions(filters: {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  amountMin?: number;
  amountMax?: number;
}): Promise<Transaction[]> {
  let query = actualApi.q('transactions')
    .select(['id', 'date', 'amount', 'payee', 'category', 'notes', 'account']);
  if (filters.startDate) query = query.filter({ date: { $gte: filters.startDate } });
  if (filters.endDate) query = query.filter({ date: { $lte: filters.endDate } });
  if (filters.accountId) query = query.filter({ account: filters.accountId });
  if (filters.categoryId) query = query.filter({ category: filters.categoryId });
  if (filters.amountMin !== undefined) query = query.filter({ amount: { $gte: filters.amountMin } });
  if (filters.amountMax !== undefined) query = query.filter({ amount: { $lte: filters.amountMax } });
  const result = await actualApi.runQuery(query);
  return (result as { data: Record<string, unknown>[] }).data.map((tx) => sanitizeObject(tx) as unknown as Transaction);
}

export async function getBudgetStatus(month?: string): Promise<CategoryStatus[]> {
  const targetMonth = month ?? new Date().toISOString().slice(0, 7);
  const data = await actualApi.getBudgetMonth(targetMonth);
  return (data.categoryGroups as Array<{ is_income?: boolean; categories: unknown[] }>).flatMap((g) =>
    (g.categories as Array<Record<string, unknown>>).map((c) => ({
      id: String(c['id']),
      name: sanitizeObject({ name: String(c['name']) }).name,
      budgeted: Number(c['budgeted']),
      spent: Number(c['spent']),
      available: Number(c['balance']),
      isIncome: g.is_income === true,
    }))
  );
}

export async function getScheduledTransactions(): Promise<ScheduledTransaction[]> {
  const scheduled = await actualApi.getSchedules();
  return (scheduled as unknown as Array<Record<string, unknown>>).map(
    (s) => sanitizeObject(s) as unknown as ScheduledTransaction
  );
}

export async function setCategoryForTransaction(txId: string, categoryId: string): Promise<void> {
  await actualApi.updateTransaction(txId, { category: categoryId });
}

export async function syncAllAccounts(): Promise<{
  synced: string[];
  failed: { id: string; name: string; error: string }[];
}> {
  const accounts = await actualApi.getAccounts() as Array<{ id: string; name: string; closed: boolean; offbudget: boolean }>;
  const onBudget = accounts.filter((a) => !a.closed && !a.offbudget);

  const synced: string[] = [];
  const failed: { id: string; name: string; error: string }[] = [];

  for (const account of onBudget) {
    let lastErr: unknown;
    let succeeded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000));
        await actualApi.runBankSync({ accountId: account.id });
        synced.push(account.name);
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!succeeded) {
      failed.push({ id: account.id, name: account.name, error: String(lastErr) });
    }
  }

  return { synced, failed };
}

export async function allocateBudget(month: string, categoryId: string, amount: number): Promise<void> {
  await actualApi.setBudgetAmount(month, categoryId, amount);
}

export async function pruneTransactions(
  before: string,
  dryRun: boolean
): Promise<{ deleted: number; dryRun: boolean; sample: string[] }> {
  const result = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({ date: { $lt: before } })
      .options({ splits: 'none' })
      .select(['id', 'date', 'payee', 'amount'])
  );
  const rows = (result as { data: Array<{ id: string; date: string; payee: string; amount: number }> }).data;

  const sample = rows.slice(0, 5).map((r) => `${r.date} ${r.payee ?? '(no payee)'} $${(r.amount / 100).toFixed(2)}`);

  if (!dryRun) {
    for (let i = 0; i < rows.length; i++) {
      await actualApi.deleteTransaction(rows[i].id);
      // Yield to the event loop every 50 deletes so liveness probes stay healthy
      if (i % 50 === 49) await new Promise((r) => setImmediate(r));
    }
  }

  return { deleted: rows.length, dryRun, sample };
}
