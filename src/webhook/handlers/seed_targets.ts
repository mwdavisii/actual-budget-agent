import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { getBudgetStatus } from '../../actual/queries';
import { seedTargets } from '../../db/targets';
import { getAppContext } from '../../agent/index';
import { getOrCreateThread, postToThread } from '../../discord/threads';
import { logger } from '../../logger';

export async function handleSeedTargets(ctx: WebhookContext): Promise<void> {
  const { discord, secrets, db } = getAppContext();

  let categories;
  try {
    categories = await withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword, getBudgetStatus);
  } catch (err) {
    logger.error('Actual unreachable (seed targets)', { err: String(err) });
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    await errChannel?.send('⚠️ Could not reach Actual Budget for target seeding.').catch(() => {});
    return;
  }

  const count = seedTargets(db, categories);
  const month = new Date().toISOString().slice(0, 7);
  logger.info('Budget targets seeded', { count, month });

  const thread = await getOrCreateThread(discord, secrets.discordBudgetChannelId, `Budget targets seeded — ${month}`);
  await postToThread(discord, thread.id, `Seeded ${count} budget targets for ${month}.`);
}
