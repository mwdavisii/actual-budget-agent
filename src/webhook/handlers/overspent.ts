import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { getBudgetStatus } from '../../actual/queries';
import { getDynamicConfig } from '../../config';
import { buildOverspendAlert } from '../../email/templates';
import { sendEmail } from '../../email/client';
import { runAgentForAlert, getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleOverspent(ctx: WebhookContext): Promise<void> {
  const { discord, db, secrets, emailTransporter } = getAppContext();
  const { overspendThresholdDollars, emailCategories } = getDynamicConfig();

  let categories;
  try {
    categories = await withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      getBudgetStatus);
  } catch (err) {
    logger.error('Actual unreachable (overspent)', { err: String(err) });
    return;
  }

  const overspent = categories.filter((c) => c.available < 0);
  if (overspent.length === 0) return;

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await runAgentForAlert(
    discord, db, secrets,
    `${overspent.length} overspent categor${overspent.length > 1 ? 'ies' : 'y'} — ${date}`,
    `These categories are overspent: ${JSON.stringify(overspent)}. Please summarize.`
  );

  for (const cat of overspent) {
    const thresholdCents = overspendThresholdDollars * 100;
    if (emailCategories.includes(cat.name) && Math.abs(cat.available) >= thresholdCents) {
      const { subject, body } = buildOverspendAlert(cat.name, Math.abs(cat.available), cat.available);
      await sendEmail(emailTransporter, secrets.email, secrets.additionalEmails, subject, body);
    }
  }
}
