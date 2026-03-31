import { actualApi } from './client';
import { sanitizeObject } from '../sanitize';
import { getDynamicConfig } from '../config';
import { logger } from '../logger';

export interface UnclearedTransaction {
  id: string;
  date: string;
  amount: number;
  payee: string;
  payeeName: string;
  category: string | null;
  categoryName: string;
  account: string;
  accountName: string;
  cleared: boolean;
}

export interface ClearedCandidate {
  id: string;
  date: string;
  amount: number;
  payee: string;
  account: string;
}

export interface StalePendingMatch {
  pending: UnclearedTransaction;
  cleared: ClearedCandidate;
}

/**
 * Pure matching logic — no API calls. Exported for testing.
 *
 * For each uncleared transaction, find the closest cleared transaction
 * from the same payee + account within dateWindowDays where
 * |cleared.amount| >= |pending.amount| (tip was added, amounts are negative).
 *
 * Each cleared transaction can only match one pending transaction.
 */
export function findMatches(
  uncleared: UnclearedTransaction[],
  cleared: ClearedCandidate[],
  dateWindowDays: number
): StalePendingMatch[] {
  const matches: StalePendingMatch[] = [];
  const usedClearedIds = new Set<string>();

  for (const pending of uncleared) {
    const pendingDate = new Date(pending.date);
    let bestMatch: ClearedCandidate | null = null;
    let bestDistance = Infinity;

    for (const candidate of cleared) {
      if (usedClearedIds.has(candidate.id)) continue;
      if (candidate.payee !== pending.payee) continue;
      if (candidate.account !== pending.account) continue;

      // Both amounts are negative (spending). Cleared should be more negative (larger spend with tip).
      if (candidate.amount > pending.amount) continue;

      const candidateDate = new Date(candidate.date);
      const daysDiff = Math.abs(candidateDate.getTime() - pendingDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > dateWindowDays) continue;

      if (daysDiff < bestDistance) {
        bestDistance = daysDiff;
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      usedClearedIds.add(bestMatch.id);
      matches.push({ pending, cleared: bestMatch });
    }
  }

  return matches;
}

/**
 * Query Actual Budget for stale uncleared transactions and their
 * potential cleared counterparts. Returns matched pairs.
 */
export async function findStalePendingTransactions(): Promise<StalePendingMatch[]> {
  const config = getDynamicConfig();
  const ageDays = config.stalePendingAgeDays;
  const categoryNames = config.stalePendingCategories;

  // Resolve category names to IDs
  const groups = await actualApi.getCategoryGroups() as Array<{
    categories: Array<{ id: string; name: string }>;
  }>;
  const allCategories = groups.flatMap(g => g.categories);
  const categoryIds = categoryNames
    .map(name => allCategories.find(c => c.name.toLowerCase() === name.toLowerCase()))
    .filter((c): c is { id: string; name: string } => c != null)
    .map(c => c.id);

  if (categoryIds.length === 0) {
    logger.warn('No matching categories found for stale pending detection', { categoryNames });
    return [];
  }

  // Build a category name lookup
  const categoryMap = Object.fromEntries(allCategories.map(c => [c.id, c.name]));

  // Get on-budget accounts
  const accounts = await actualApi.getAccounts() as Array<{
    id: string; name: string; closed: boolean; offbudget: boolean;
  }>;
  const onBudgetAccounts = accounts.filter(a => !a.closed && !a.offbudget);
  const onBudgetIds = onBudgetAccounts.map(a => a.id);
  const accountMap = Object.fromEntries(onBudgetAccounts.map(a => [a.id, a.name]));

  // Get payee names for display
  const payees = await actualApi.getPayees() as Array<{ id: string; name: string }>;
  const payeeMap = Object.fromEntries(payees.map(p => [p.id, p.name]));

  // Cutoff date: transactions older than ageDays are "stale"
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ageDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Query uncleared transactions in target categories, older than cutoff
  const unclearedResult = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({
        cleared: false,
        date: { $lte: cutoffStr },
        category: { $oneof: categoryIds },
        account: { $oneof: onBudgetIds },
        transfer_id: null,
      })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'payee', 'category', 'account', 'cleared'])
  );
  const unclearedRows = (unclearedResult as { data: Array<Record<string, unknown>> }).data;

  if (unclearedRows.length === 0) {
    logger.info('No stale uncleared transactions found');
    return [];
  }

  const uncleared: UnclearedTransaction[] = unclearedRows.map(row => {
    const sanitized = sanitizeObject(row) as Record<string, unknown>;
    return {
      id: String(sanitized['id']),
      date: String(sanitized['date']),
      amount: Number(sanitized['amount']),
      payee: String(sanitized['payee']),
      payeeName: payeeMap[String(row['payee'])] ?? String(sanitized['payee']),
      category: sanitized['category'] ? String(sanitized['category']) : null,
      categoryName: categoryMap[String(row['category'])] ?? '',
      account: String(sanitized['account']),
      accountName: accountMap[String(row['account'])] ?? '',
      cleared: false,
    };
  });

  // Query cleared transactions from those same payees/accounts in a wider window
  // (from earliest uncleared date - dateWindow to now)
  const earliestDate = uncleared.reduce((min, u) => u.date < min ? u.date : min, uncleared[0].date);
  const windowStart = new Date(earliestDate);
  windowStart.setDate(windowStart.getDate() - ageDays);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const uniquePayeeIds = [...new Set(uncleared.map(u => u.payee))];
  const uniqueAccountIds = [...new Set(uncleared.map(u => u.account))];

  const clearedResult = await actualApi.runQuery(
    actualApi.q('transactions')
      .filter({
        cleared: true,
        date: { $gte: windowStartStr },
        payee: { $oneof: uniquePayeeIds },
        account: { $oneof: uniqueAccountIds },
        transfer_id: null,
      })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'payee', 'account'])
  );
  const clearedRows = (clearedResult as { data: Array<Record<string, unknown>> }).data;

  const cleared: ClearedCandidate[] = clearedRows.map(row => ({
    id: String(row['id']),
    date: String(row['date']),
    amount: Number(row['amount']),
    payee: String(row['payee']),
    account: String(row['account']),
  }));

  logger.info('Stale pending scan', {
    unclearedCount: uncleared.length,
    clearedCandidates: cleared.length,
  });

  return findMatches(uncleared, cleared, ageDays);
}
