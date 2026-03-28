import { actualApi } from './client';
import { sanitizeObject } from '../sanitize';
import type Database from 'better-sqlite3';
import {
  getIncompleteCleanup,
  getMostRecentCompleted,
  insertCleanupState,
  updateCleanupPhase,
  deleteOldCompletedStates,
  deleteCleanupState,
  type CleanupState,
  type CleanupPhase,
} from '../db/cleanup';
import { logger } from '../logger';

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
  dryRun: boolean,
  db?: Database.Database,
  clearState?: boolean,
  onProgress?: (count: number, total: number) => Promise<void>
): Promise<{ deleted: number; dryRun: boolean; sample: string[] }> {
  const result = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({ date: { $lt: before } })
      .options({ splits: 'none' })
      .select(['id', 'date', 'payee', 'amount', 'category', 'account'])
  );
  const rows = (result as { data: Array<{
    id: string; date: string; payee: string; amount: number;
    category: string | null; account: string;
  }> }).data;

  const sample = rows.slice(0, 5).map(
    (r) => `${r.date} ${r.payee ?? '(no payee)'} $${(r.amount / 100).toFixed(2)}`
  );

  if (dryRun) {
    return { deleted: rows.length, dryRun, sample };
  }

  if (!db) throw new Error('db is required for non-dry-run prune');

  deleteOldCompletedStates(db);

  if (clearState) {
    const existing = getIncompleteCleanup(db);
    if (existing) {
      if (existing.phase !== 'pending' && rows.length < existing.transactionIds.length) {
        throw new Error(
          `Cannot clear state: ${existing.transactionIds.length - rows.length} transactions were already deleted ` +
          `(snapshot had ${existing.transactionIds.length}, now ${rows.length}). ` +
          `Restore from backup before using clear_state=true, or resume without it.`
        );
      }
      logger.info('Clearing incomplete cleanup state', { cutoff_date: existing.cutoffDate });
      deleteCleanupState(db, existing.cutoffDate);
    }
  }

  let state = getIncompleteCleanup(db);

  // No transactions and no incomplete state — nothing to do
  if (rows.length === 0 && !state) {
    return { deleted: 0, dryRun: false, sample };
  }
  if (state && state.cutoffDate !== before) {
    throw new Error(
      `A cleanup for cutoff ${state.cutoffDate} is incomplete (phase: ${state.phase}). ` +
      `Complete it first or use clear_state=true to abandon it.`
    );
  }

  // Phase 0: Snapshot
  if (!state) {
    logger.info('Cleanup phase started', { phase: 'snapshot', cutoff_date: before });

    const accounts = await actualApi.getAccounts() as Array<{
      id: string; name: string; closed: boolean; offbudget: boolean;
    }>;
    const onBudgetIds = new Set(accounts.filter((a) => !a.closed && !a.offbudget).map((a) => a.id));

    const accountAdjustments: Record<string, number> = {};
    for (const row of rows) {
      if (onBudgetIds.has(row.account)) {
        accountAdjustments[row.account] = (accountAdjustments[row.account] ?? 0) + row.amount;
      }
    }

    const [byear, bmonth] = before.split('-').map(Number);
    const lastZeroedYear = bmonth === 1 ? byear - 1 : byear;
    const lastZeroedMonthNum = bmonth === 1 ? 12 : bmonth - 1;
    const lastZeroedMonth = `${lastZeroedYear}-${String(lastZeroedMonthNum).padStart(2, '0')}`;
    const firstKeptMonth = `${byear}-${String(bmonth).padStart(2, '0')}`;

    const lastZeroedData = await actualApi.getBudgetMonth(lastZeroedMonth) as unknown as {
      categoryGroups: Array<{ is_income?: boolean; categories: Array<{ id: string; balance: number }> }>;
    };
    const categoryCarryForwards: Record<string, number> = {};
    for (const group of lastZeroedData.categoryGroups) {
      if (group.is_income) continue;
      for (const cat of group.categories) {
        categoryCarryForwards[cat.id] = Number(cat.balance);
      }
    }

    const firstKeptData = await actualApi.getBudgetMonth(firstKeptMonth) as unknown as {
      categoryGroups: Array<{ categories: Array<{ id: string; budgeted: number }> }>;
    };
    const firstKeptBudgets: Record<string, number> = {};
    for (const group of firstKeptData.categoryGroups) {
      for (const cat of group.categories) {
        firstKeptBudgets[cat.id] = Number(cat.budgeted);
      }
    }

    const sortedDates = rows.map((r) => r.date).sort();
    const [ey, em] = sortedDates[0].split('-').map(Number);
    const earliestBudgetMonth = `${ey}-${String(em).padStart(2, '0')}`;

    state = {
      cutoffDate: before,
      accountAdjustments,
      categoryCarryForwards,
      firstKeptBudgets,
      transactionIds: rows.map((r) => r.id),
      earliestBudgetMonth,
      phase: 'pending',
    };
    insertCleanupState(db, state);
    logger.info('Cleanup phase complete', { phase: 'snapshot', cutoff_date: before, ops_count: rows.length });
  } else {
    logger.warn('Resuming interrupted cleanup', { phase: state.phase, cutoff_date: before });
  }

  // Phase dispatch
  const phases: CleanupPhase[] = ['pending', 'deleting', 'adjustments', 'budgets', 'zeroed'];
  const startIndex = phases.indexOf(state.phase);

  for (let i = startIndex; i < phases.length; i++) {
    const phase = phases[i];
    if (phase === 'pending') {
      updateCleanupPhase(db, before, 'deleting');
      state.phase = 'deleting';
    } else if (phase === 'deleting') {
      await executePhaseDelete(state, onProgress);
      updateCleanupPhase(db, before, 'adjustments');
      state.phase = 'adjustments';
    } else if (phase === 'adjustments') {
      await executePhaseAdjustments(state);
      updateCleanupPhase(db, before, 'budgets');
      state.phase = 'budgets';
    } else if (phase === 'budgets') {
      await executePhaseBudgets(state);
      updateCleanupPhase(db, before, 'zeroed');
      state.phase = 'zeroed';
    } else if (phase === 'zeroed') {
      await executePhaseZero(state);
      updateCleanupPhase(db, before, 'complete');
      state.phase = 'complete';
    }
  }

  return { deleted: state.transactionIds.length, dryRun: false, sample };
}

// Phase implementations — stubbed, filled in subsequent tasks

async function executePhaseDelete(
  state: CleanupState,
  onProgress?: (count: number, total: number) => Promise<void>
): Promise<void> {
  logger.info('Cleanup phase started', { phase: 'deleting', cutoff_date: state.cutoffDate });
  const total = state.transactionIds.length;
  if (onProgress) await onProgress(0, total);
  let count = 0;
  for (const id of state.transactionIds) {
    try {
      await actualApi.deleteTransaction(id);
    } catch (err) {
      logger.warn('Transaction delete skipped', { id, error: String(err) });
    }
    count++;
    if (count % 500 === 0) logger.info('Delete progress', { count, total });
    if (count % 100 === 0 && onProgress) await onProgress(count, total);
    await new Promise((r) => setImmediate(r));
  }
  if (onProgress) await onProgress(total, total);
  logger.info('Cleanup phase complete', { phase: 'deleting', cutoff_date: state.cutoffDate, ops_count: count });
}

async function executePhaseAdjustments(state: CleanupState): Promise<void> {
  logger.info('Cleanup phase started', { phase: 'adjustments', cutoff_date: state.cutoffDate });

  // Find an income category so adjustments feed "To Budget" (like starting balances)
  const [byear, bmonth] = state.cutoffDate.split('-').map(Number);
  const firstKeptMonth = `${byear}-${String(bmonth).padStart(2, '0')}`;
  const budgetData = await actualApi.getBudgetMonth(firstKeptMonth) as unknown as {
    categoryGroups: Array<{ is_income?: boolean; categories: Array<{ id: string; name: string }> }>;
  };
  const incomeGroup = budgetData.categoryGroups.find((g) => g.is_income);
  const incomeCategoryId = incomeGroup?.categories[0]?.id;
  if (!incomeCategoryId) {
    throw new Error('No income category found — cannot create adjustment transactions that feed To Budget');
  }
  logger.info('Using income category for adjustments', { categoryId: incomeCategoryId });

  let created = 0;
  for (const [accountId, amount] of Object.entries(state.accountAdjustments)) {
    const marker = `cleanup:${state.cutoffDate}:${accountId}`;
    const existing = await actualApi.runQuery(
      actualApi.q('transactions')
        .filter({ account: accountId, date: state.cutoffDate, notes: { $like: `%${marker}%` } })
        .options({ splits: 'none' })
        .select(['id'])
    );
    if ((existing as { data: unknown[] }).data.length > 0) {
      logger.info('Adjustment transaction already exists, skipping', { accountId });
      continue;
    }
    await actualApi.addTransactions(accountId, [{
      date: state.cutoffDate,
      amount,
      payee_name: 'Prior Balance',
      notes: marker,
      category: incomeCategoryId,
    }]);
    created++;
    await new Promise((r) => setImmediate(r));
  }
  logger.info('Cleanup phase complete', { phase: 'adjustments', cutoff_date: state.cutoffDate, ops_count: created });
}

async function executePhaseBudgets(state: CleanupState): Promise<void> {
  logger.info('Cleanup phase started', { phase: 'budgets', cutoff_date: state.cutoffDate });
  const [byear, bmonth] = state.cutoffDate.split('-').map(Number);
  const firstKeptMonth = `${byear}-${String(bmonth).padStart(2, '0')}`;

  let count = 0;
  for (const [catId, carryForward] of Object.entries(state.categoryCarryForwards)) {
    const existing = state.firstKeptBudgets[catId] ?? 0;
    const target = existing + carryForward;
    await actualApi.setBudgetAmount(firstKeptMonth, catId, target);
    count++;
    await new Promise((r) => setImmediate(r));
  }
  logger.info('Cleanup phase complete', { phase: 'budgets', cutoff_date: state.cutoffDate, ops_count: count });
}

async function executePhaseZero(state: CleanupState): Promise<void> {
  logger.info('Cleanup phase started', { phase: 'zeroed', cutoff_date: state.cutoffDate });

  const [byear, bmonth] = state.cutoffDate.split('-').map(Number);
  const lastZeroedYear = bmonth === 1 ? byear - 1 : byear;
  const lastZeroedMonthNum = bmonth === 1 ? 12 : bmonth - 1;
  const lastZeroedMonth = `${lastZeroedYear}-${String(lastZeroedMonthNum).padStart(2, '0')}`;

  let [y, m] = state.earliestBudgetMonth.split('-').map(Number);
  const [ey, em] = lastZeroedMonth.split('-').map(Number);
  let totalOps = 0;

  while (y < ey || (y === ey && m <= em)) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const data = await actualApi.getBudgetMonth(month) as unknown as {
      categoryGroups: Array<{ categories: Array<{ id: string; budgeted: number }> }>;
    };
    for (const group of data.categoryGroups) {
      for (const cat of group.categories) {
        if (Number(cat.budgeted) !== 0) {
          await actualApi.setBudgetAmount(month, cat.id, 0);
          totalOps++;
          if (totalOps % 500 === 0) logger.info('Zero progress', { count: totalOps });
          await new Promise((r) => setImmediate(r));
        }
      }
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }
  logger.info('Cleanup phase complete', { phase: 'zeroed', cutoff_date: state.cutoffDate, ops_count: totalOps });
}

export async function revertCarryForwards(
  db: Database.Database,
  dryRun: boolean
): Promise<{ cutoffDate: string; reverted: number; dryRun: boolean; sample: string[] }> {
  const state = getMostRecentCompleted(db);
  if (!state) throw new Error('No completed cleanup state found — nothing to revert');

  const [byear, bmonth] = state.cutoffDate.split('-').map(Number);
  const firstKeptMonth = `${byear}-${String(bmonth).padStart(2, '0')}`;

  const sample: string[] = [];
  let reverted = 0;

  for (const [catId, carryForward] of Object.entries(state.categoryCarryForwards)) {
    if (carryForward === 0) continue;
    const original = state.firstKeptBudgets[catId] ?? 0;
    if (sample.length < 5) {
      sample.push(`cat:${catId} carry=${(carryForward / 100).toFixed(2)} → reset to ${(original / 100).toFixed(2)}`);
    }
    if (!dryRun) {
      await actualApi.setBudgetAmount(firstKeptMonth, catId, original);
      await new Promise((r) => setImmediate(r));
    }
    reverted++;
  }

  return { cutoffDate: state.cutoffDate, reverted, dryRun, sample };
}

export function getRollingPruneCutoff(months: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - months + 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

export async function cleanupHiddenCategories(dryRun: boolean, cutoff?: string): Promise<{
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
      const filter: Record<string, unknown> = { category: cat.id };
      if (cutoff) filter['date'] = { $gte: cutoff };
      const result = await actualApi.runQuery(
        actualApi.q('transactions').filter(filter).options({ splits: 'none' }).select(['id'])
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

export async function cleanupClosedAccounts(dryRun: boolean, cutoff?: string): Promise<{
  deleted: number; names: string[]; warnings: string[];
}> {
  const accounts = await actualApi.getAccounts() as Array<{ id: string; name: string; closed: boolean }>;
  const closed = accounts.filter((a) => a.closed);

  const deletedNames: string[] = [];
  const warnings: string[] = [];

  for (const account of closed) {
    const filter: Record<string, unknown> = { account: account.id };
    if (cutoff) filter['date'] = { $gte: cutoff };
    const result = await actualApi.runQuery(
      actualApi.q('transactions').filter(filter).options({ splits: 'none' }).select(['id'])
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
