import type { WebhookContext } from '../server';
import type { CategoryStatus, Transaction } from '../../actual/queries';
import { withActual } from '../../actual/client';
import { getBudgetStatus, getTransactions } from '../../actual/queries';
import { getDynamicConfig } from '../../config';
import { buildWeeklyDigest } from '../../email/templates';
import { sendEmail } from '../../email/client';
import { getAppContext } from '../../agent/index';
import { getOrCreateThread, postToThread } from '../../discord/threads';
import { logger } from '../../logger';

function dollars(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export async function handleWeeklyDigest(ctx: WebhookContext): Promise<void> {
  const { discord, secrets, emailTransporter } = getAppContext();
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

  // Discord summary (always posted)
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sorted = [...relevant].sort((a, b) => a.spent - b.spent); // most spent first (spending is negative)
  const lines = [
    `**Total spent this week:** ${dollars(weekSpent)}`,
    '',
    ...sorted.map((c) => {
      const status = c.available < 0 ? '**over budget**' : 'on track';
      return `• **${c.name}**: spent ${dollars(c.spent)} of ${dollars(c.budgeted)} — ${status}`;
    }),
  ];
  const thread = await getOrCreateThread(discord, secrets.discordBudgetChannelId, `Weekly digest — ${date}`);
  await postToThread(discord, thread.id, lines.join('\n'));
  logger.info('Weekly digest posted to Discord');

  // Email (only if enabled)
  if (secrets.enableEmail) {
    const { subject, body } = buildWeeklyDigest(relevant, weekSpent);
    await sendEmail(emailTransporter, secrets.email, secrets.additionalEmails, subject, body);
    logger.info('Weekly digest email sent');
  }
}
