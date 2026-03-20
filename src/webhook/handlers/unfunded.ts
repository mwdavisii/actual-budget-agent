import type { WebhookContext } from '../server';
import type { CategoryStatus, ScheduledTransaction } from '../../actual/queries';
import { withActual } from '../../actual/client';
import { getScheduledTransactions, getBudgetStatus } from '../../actual/queries';
import { runAgentForAlert, getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleUnfunded(ctx: WebhookContext): Promise<void> {
  const { discord, db, secrets } = getAppContext();

  let scheduled: ScheduledTransaction[], budget: CategoryStatus[];
  try {
    const result = await withActual(
      ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      async () => {
        const s = await getScheduledTransactions();
        const b = await getBudgetStatus();
        return [s, b] as const;
      }
    );
    [scheduled, budget] = result;
  } catch (err) {
    logger.error('Actual unreachable (unfunded)', { err: String(err) });
    return;
  }

  const unfunded = scheduled.filter((s) => {
    const cat = budget.find((c) => c.name === s.category);
    return cat && cat.available < Math.abs(s.amount);
  });

  if (unfunded.length === 0) return;

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await runAgentForAlert(
    discord, db, secrets,
    `${unfunded.length} upcoming bill${unfunded.length > 1 ? 's' : ''} underfunded — ${date}`,
    `These upcoming scheduled transactions do not have sufficient budget: ${JSON.stringify(unfunded)}. Please summarize.`
  );
}
