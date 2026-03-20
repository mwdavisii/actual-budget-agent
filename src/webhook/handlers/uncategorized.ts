import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { getUncategorizedTransactions } from '../../actual/queries';
import { runAgentForAlert, getAppContext } from '../../agent/index';
import { logger } from '../../logger';

export async function handleUncategorized(ctx: WebhookContext): Promise<void> {
  const { discord, secrets } = getAppContext();

  let txs;
  try {
    txs = await withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      getUncategorizedTransactions);
  } catch (err) {
    logger.error('Actual unreachable (uncategorized)', { err: String(err) });
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    await errChannel?.send('⚠️ Could not reach Actual Budget for uncategorized check.').catch(() => {});
    return;
  }

  if (txs.length === 0) { logger.info('No uncategorized transactions'); return; }

  const MAX_TXS = 50;
  if (txs.length > MAX_TXS) {
    logger.warn('Truncating uncategorized transactions', { total: txs.length, limit: MAX_TXS });
    txs = txs.slice(0, MAX_TXS);
  }

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await runAgentForAlert(
    discord, getAppContext().db, secrets,
    `${txs.length} uncategorized transaction${txs.length > 1 ? 's' : ''} — ${date}`,
    `There are ${txs.length} uncategorized transactions. Review each and propose a category. Transactions: ${JSON.stringify(txs)}`
  );
}
