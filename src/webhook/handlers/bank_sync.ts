import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { syncAllAccounts } from '../../actual/queries';
import { handleUncategorized } from './uncategorized';
import { getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleBankSync(ctx: WebhookContext): Promise<void> {
  const { discord, secrets } = getAppContext();

  let result;
  try {
    result = await withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword, syncAllAccounts);
  } catch (err) {
    logger.error('Bank sync failed completely', { err: String(err) });
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    await errChannel?.send('⚠️ Bank sync failed — could not connect to Actual Budget.').catch(() => {});
    return;
  }

  logger.info('Bank sync complete', { synced: result.synced.length, failed: result.failed.length });

  if (result.failed.length > 0) {
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    const failList = result.failed.map((f) => `• ${f.name}: ${f.error}`).join('\n');
    await errChannel?.send(`⚠️ Bank sync failed for ${result.failed.length} account(s):\n${failList}`).catch(() => {});
  }

  if (result.synced.length > 0) {
    await handleUncategorized(ctx);
  } else {
    logger.warn('No accounts synced successfully — skipping uncategorized check');
  }
}
