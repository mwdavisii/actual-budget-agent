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
    try {
      await actualApi.runBankSync({ accountId: account.id });
      synced.push(account.name);
    } catch (err) {
      failed.push({ id: account.id, name: account.name, error: String(err) });
    }
  }

  return { synced, failed };
}

export async function allocateBudget(month: string, categoryId: string, amount: number): Promise<void> {
  await actualApi.setBudgetAmount(month, categoryId, amount);
}

export async function pruneTransactions(cutoff: string, dryRun: boolean): Promise<{
  deleted: number; dryRun: boolean; sample: string[];
}> {
  const result = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({ date: { $lt: cutoff } })
      .options({ splits: 'none' })
      .select(['id', 'date', 'payee_name', 'amount'])
  ) as { data: Array<{ id: string; date: string; payee_name?: string; amount?: number }> };

  const rows = result.data;
  if (!dryRun) {
    for (const row of rows) {
      await actualApi.deleteTransaction(row.id);
    }
  }

  const sample = rows.slice(0, 5).map((r) => {
    const amountStr = r.amount != null ? ` $${(Math.abs(r.amount) / 100).toFixed(2)}` : '';
    return `${r.date} ${r.payee_name ?? 'Unknown'}${amountStr}`;
  });

  return { deleted: rows.length, dryRun, sample };
}

export function getRollingPruneCutoff(months: number): string {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1); // Anchor to 1st before subtracting months to prevent overflow
  d.setMonth(d.getMonth() - months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  // Format as YYYY-MM-DD using local date parts
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const dayStr = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${dayStr}`;
}

export async function cleanupHiddenCategories(dryRun: boolean): Promise<{
  deleted: number; names: string[]; warnings: string[];
}> {
  const groups = await actualApi.getCategoryGroups() as Array<{
    id: string; name: string; hidden: boolean;
    categories: Array<{ id: string; name: string; hidden: boolean }>;
  }>;

  const deletedIds = new Set<string>();
  const deletedNames: string[] = [];
  const warnings: string[] = [];

  for (const group of groups) {
    for (const cat of group.categories) {
      if (!cat.hidden) continue;
      const result = await actualApi.runQuery(
        actualApi.q('transactions').filter({ category: cat.id }).options({ splits: 'none' }).select(['id'])
      );
      if ((result as { data: unknown[] }).data.length > 0) continue;
      if (!dryRun) {
        try {
          await actualApi.deleteCategory(cat.id);
        } catch (err) {
          warnings.push(`Failed to delete category "${cat.name}": ${String(err)}`);
          continue;
        }
      }
      deletedIds.add(cat.id);
      deletedNames.push(cat.name);
    }

    if (!group.hidden) continue;
    const groupIsEmpty =
      group.categories.length === 0 ||
      group.categories.every((c) => deletedIds.has(c.id));
    if (!groupIsEmpty) continue;
    if (!dryRun) {
      try {
        await actualApi.deleteCategoryGroup(group.id);
      } catch (err) {
        warnings.push(`Failed to delete category group "${group.name}": ${String(err)}`);
        continue;
      }
    }
    deletedNames.push(group.name);
  }

  return { deleted: deletedNames.length, names: deletedNames.slice(0, 20), warnings };
}

export async function cleanupClosedAccounts(dryRun: boolean): Promise<{
  deleted: number; names: string[]; warnings: string[];
}> {
  const accounts = await actualApi.getAccounts() as Array<{ id: string; name: string; closed: boolean }>;
  const closed = accounts.filter((a) => a.closed);

  const deletedNames: string[] = [];
  const warnings: string[] = [];

  for (const account of closed) {
    const result = await actualApi.runQuery(
      actualApi.q('transactions').filter({ account: account.id }).options({ splits: 'none' }).select(['id'])
    );
    if ((result as { data: unknown[] }).data.length > 0) continue;
    if (!dryRun) {
      try {
        await actualApi.deleteAccount(account.id);
      } catch (err) {
        warnings.push(`Failed to delete account "${account.name}": ${String(err)}`);
        continue;
      }
    }
    deletedNames.push(account.name);
  }

  return { deleted: deletedNames.length, names: deletedNames.slice(0, 20), warnings };
}
