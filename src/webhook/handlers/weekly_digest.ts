import type { WebhookContext } from '../server';
import type { CategoryStatus, Transaction } from '../../actual/queries';
import { withActual } from '../../actual/client';
import { getBudgetStatus, getTransactions } from '../../actual/queries';
import { getDynamicConfig } from '../../config';
import { buildWeeklyDigest } from '../../email/templates';
import { sendEmail } from '../../email/client';
import { getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleWeeklyDigest(ctx: WebhookContext): Promise<void> {
  const { secrets, emailTransporter } = getAppContext();
  const { emailCategories } = getDynamicConfig();

  const now = new Date();
  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  let budget: CategoryStatus[], txs: Transaction[];
  try {
    const result = await withActual(
      ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      async () => {
        const b = await getBudgetStatus();
        const t = await getTransactions({ startDate, endDate });
        return [b, t] as const;
      }
    );
    [budget, txs] = result;
  } catch (err) {
    logger.error('Actual unreachable (weekly digest)', { err: String(err) });
    return;
  }

  const relevant = budget.filter((c) => emailCategories.includes(c.name));
  const weekSpent = txs.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const { subject, body } = buildWeeklyDigest(relevant, weekSpent);
  await sendEmail(emailTransporter, secrets.email, secrets.additionalEmails, subject, body);
  logger.info('Weekly digest sent');
}
