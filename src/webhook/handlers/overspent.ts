import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { getBudgetStatus } from '../../actual/queries';
import { getDynamicConfig } from '../../config';
import { buildOverspendAlert } from '../../email/templates';
import { sendEmail } from '../../email/client';
import { getAppContext } from '../../agent/index';
import { getOrCreateThread, postToThread } from '../../discord/threads';
import { logger } from '../../logger';

export async function handleOverspent(ctx: WebhookContext): Promise<void> {
  const { discord, secrets, emailTransporter } = getAppContext();
  const { overspendThresholdDollars, emailCategories } = getDynamicConfig();

  logger.info('Overspent handler: fetching budget status');

  let categories;
  try {
    categories = await withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      getBudgetStatus);
  } catch (err) {
    logger.error('Actual unreachable (overspent)', { err: String(err) });
    return;
  }

  const overspent = categories.filter((c) => c.available < 0);
  logger.info('Overspent check results', {
    totalCategories: categories.length,
    overspentCount: overspent.length,
    overspent: overspent.map((c) => ({ name: c.name, available: c.available, budgeted: c.budgeted, spent: c.spent })),
  });
  if (overspent.length === 0) return;

  // Post directly to Discord (no LLM) for troubleshooting
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const title = `${overspent.length} overspent categor${overspent.length > 1 ? 'ies' : 'y'} — ${date}`;
  const lines = overspent.map((c) => {
    const over = Math.abs(c.available) / 100;
    const spent = Math.abs(c.spent) / 100;
    return `• **${c.name}**: spent $${spent.toFixed(2)} — **over by $${over.toFixed(2)}**`;
  });

  logger.info('Overspent handler: creating Discord thread');
  const thread = await getOrCreateThread(discord, secrets.discordBudgetChannelId, title);
  logger.info('Overspent handler: posting to thread', { threadId: thread.id });
  await postToThread(discord, thread.id, lines.join('\n'));
  logger.info('Overspent handler: Discord post complete');

  if (secrets.enableEmail) {
    for (const cat of overspent) {
      const thresholdCents = overspendThresholdDollars * 100;
      if (emailCategories.includes(cat.name) && Math.abs(cat.available) >= thresholdCents) {
        const { subject, body } = buildOverspendAlert(cat.name, Math.abs(cat.available), cat.available);
        await sendEmail(emailTransporter, secrets.email, secrets.additionalEmails, subject, body);
      }
    }
  }
  logger.info('Overspent handler: complete');
}
