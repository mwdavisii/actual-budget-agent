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
      .select(['id', 'date', 'payee', 'amount', 'category'])
  );
  const rows = (result as { data: Array<{ id: string; date: string; payee: string; amount: number; category: string | null }> }).data;

  const sample = rows.slice(0, 5).map((r) => `${r.date} ${r.payee ?? '(no payee)'} $${(r.amount / 100).toFixed(2)}`);

  if (!dryRun && rows.length > 0) {
    // Determine month boundaries
    const [byear, bmonth] = before.split('-').map(Number);
    const firstKeptMonth = `${byear}-${String(bmonth).padStart(2, '0')}`;
    const lzDate = new Date(byear, bmonth - 2, 1); // month before firstKeptMonth
    const lastZeroedMonth = `${lzDate.getFullYear()}-${String(lzDate.getMonth() + 1).padStart(2, '0')}`;

    // Capture carry-forward balances from lastZeroedMonth (before any changes)
    const lastZeroedData = await actualApi.getBudgetMonth(lastZeroedMonth) as {
      categoryGroups: Array<{ is_income?: boolean; categories: Array<{ id: string; balance: number; budgeted: number }> }>;
    };
    const carryForwards: Record<string, number> = {};   // non-income only
    const allCategoryIds: string[] = [];
    for (const group of lastZeroedData.categoryGroups) {
      for (const cat of group.categories) {
        allCategoryIds.push(cat.id);
        if (!group.is_income) carryForwards[cat.id] = Number(cat.balance);
      }
    }

    // Capture existing budget amounts for firstKeptMonth (before any changes)
    const firstKeptData = await actualApi.getBudgetMonth(firstKeptMonth) as {
      categoryGroups: Array<{ categories: Array<{ id: string; budgeted: number }> }>;
    };
    const firstKeptBudgets: Record<string, number> = {};
    for (const group of firstKeptData.categoryGroups) {
      for (const cat of group.categories) {
        firstKeptBudgets[cat.id] = Number(cat.budgeted);
      }
    }

    // Sum deleted transaction amounts per category within firstKeptMonth (mid-month cutoff)
    const deletedInFirstKept: Record<string, number> = {};
    for (const row of rows) {
      if (row.date.slice(0, 7) === firstKeptMonth && row.category) {
        deletedInFirstKept[row.category] = (deletedInFirstKept[row.category] ?? 0) + row.amount;
      }
    }

    // Find earliest month across all deleted transactions
    const sortedDates = rows.map((r) => r.date).sort();
    const [ey, em] = sortedDates[0].split('-').map(Number);
    const earliestMonth = `${ey}-${String(em).padStart(2, '0')}`;
    const monthsToZero = getMonthRange(earliestMonth, lastZeroedMonth);

    // Delete transactions
    for (let i = 0; i < rows.length; i++) {
      await actualApi.deleteTransaction(rows[i].id);
      if (i % 50 === 49) await new Promise((r) => setImmediate(r));
    }

    // Zero out budget allocations for all months up through lastZeroedMonth
    let opCount = 0;
    for (const month of monthsToZero) {
      for (const catId of allCategoryIds) {
        await actualApi.setBudgetAmount(month, catId, 0);
        opCount++;
        if (opCount % 50 === 0) await new Promise((r) => setImmediate(r));
      }
    }

    // Apply carry-forward adjustment to firstKeptMonth for non-income categories
    for (const catId of Object.keys(carryForwards)) {
      const carryForward = carryForwards[catId];
      const deletedInMonth = deletedInFirstKept[catId] ?? 0;
      const adjustment = carryForward + deletedInMonth; // deletedInMonth is negative for expenses
      if (adjustment !== 0) {
        const existingBudget = firstKeptBudgets[catId] ?? 0;
        await actualApi.setBudgetAmount(firstKeptMonth, catId, existingBudget + adjustment);
      }
    }
  } else if (!dryRun) {
    // no-op: no transactions to prune
  } else {
    // dry run — nothing to do
  }

  return { deleted: rows.length, dryRun, sample };
}

function getMonthRange(start: string, end: string): string[] {
  const months: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
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
