import type { WebhookContext } from '../server';
import type { CategoryStatus, Transaction } from '../../actual/queries';
import { withActual } from '../../actual/client';
import { getBudgetStatus, getTransactions } from '../../actual/queries';
import { runAgentForAlert, getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleMonthlyReview(ctx: WebhookContext): Promise<void> {
  const { discord, db, secrets } = getAppContext();

  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthStr = prevMonth.toISOString().slice(0, 7);
  const startDate = `${monthStr}-01`;
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  let budget: CategoryStatus[], txs: Transaction[];
  try {
    const result = await withActual(
      ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      async () => {
        const b = await getBudgetStatus(monthStr);
        const t = await getTransactions({ startDate, endDate });
        return [b, t] as const;
      }
    );
    [budget, txs] = result;
  } catch (err) {
    logger.error('Actual unreachable (monthly review)', { err: String(err) });
    return;
  }

  const totalIncome = txs.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalSpent = txs.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const monthName = prevMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  await runAgentForAlert(
    discord, db, secrets,
    `Monthly Review — ${monthName}`,
    `Monthly review for ${monthStr}. Income: ${totalIncome} cents. Spending: ${totalSpent} cents. Category performance: ${JSON.stringify(budget)}. Please summarize how last month went.`
  );
}
