import type { WebhookPayload, WebhookContext } from '../server';
import { logger } from '../../logger';

export async function dispatchCheckType(payload: WebhookPayload, ctx: WebhookContext): Promise<void> {
  switch (payload.checkType) {
    case 'uncategorized_transactions': {
      const { handleUncategorized } = await import('./uncategorized');
      return handleUncategorized(ctx);
    }
    case 'overspent_categories': {
      const { handleOverspent } = await import('./overspent');
      return handleOverspent(ctx);
    }
    case 'unfunded_bills': {
      const { handleUnfunded } = await import('./unfunded');
      return handleUnfunded(ctx);
    }
    case 'monthly_review': {
      const { handleMonthlyReview } = await import('./monthly_review');
      return handleMonthlyReview(ctx);
    }
    case 'weekly_digest': {
      const { handleWeeklyDigest } = await import('./weekly_digest');
      return handleWeeklyDigest(ctx);
    }
    default:
      logger.warn('Unknown checkType', { checkType: (payload as { checkType: string }).checkType });
  }
}
