import type { WebhookPayload, WebhookContext } from '../server';
import { getSecrets } from '../../config';
import { logger } from '../../logger';

export async function dispatchCheckType(payload: WebhookPayload, ctx: WebhookContext): Promise<void> {
  const secrets = getSecrets();

  switch (payload.checkType) {
    case 'uncategorized_transactions': {
      if (!secrets.enableLlm) { logger.info('Skipping uncategorized — LLM disabled'); return; }
      const { handleUncategorized } = await import('./uncategorized');
      return handleUncategorized(ctx);
    }
    case 'overspent_categories': {
      const { handleOverspent } = await import('./overspent');
      return handleOverspent(ctx);
    }
    case 'unfunded_bills': {
      if (!secrets.enableLlm) { logger.info('Skipping unfunded — LLM disabled'); return; }
      const { handleUnfunded } = await import('./unfunded');
      return handleUnfunded(ctx);
    }
    case 'monthly_review': {
      if (!secrets.enableLlm) { logger.info('Skipping monthly review — LLM disabled'); return; }
      const { handleMonthlyReview } = await import('./monthly_review');
      return handleMonthlyReview(ctx);
    }
    case 'weekly_digest': {
      const { handleWeeklyDigest } = await import('./weekly_digest');
      return handleWeeklyDigest(ctx);
    }
    case 'bank_sync': {
      const { handleBankSync } = await import('./bank_sync');
      return handleBankSync(ctx);
    }
    case 'seed_targets': {
      if (!secrets.enableSeedTargets) { logger.info('Skipping seed targets — disabled'); return; }
      const { handleSeedTargets } = await import('./seed_targets');
      return handleSeedTargets(ctx);
    }
    case 'allocate_pay_period': {
      if (!secrets.enablePayPeriodAllocation) { logger.info('Skipping pay-period allocation — disabled'); return; }
      const { handleAllocatePayPeriod } = await import('./allocate_budget');
      return handleAllocatePayPeriod(ctx);
    }
    default:
      logger.warn('Unknown checkType', { checkType: (payload as { checkType: string }).checkType });
  }
}
