import type { WebhookContext } from '../server';
import { withActual } from '../../actual/client';
import { getBudgetStatus, getScheduledTransactions, allocateBudget } from '../../actual/queries';
import { getTargets } from '../../db/targets';
import { getAppContext } from '../../agent/index';
import { getDynamicConfig } from '../../config';
import { isPayday, nextPayday, getPaydayOrdinalInMonth } from '../../pay-period';
import { getOrCreateThread, postToThread } from '../../discord/threads';
import { logger } from '../../logger';

export async function handleAllocatePayPeriod(ctx: WebhookContext, forceDate?: string): Promise<void> {
  const { discord, secrets, db } = getAppContext();
  const config = getDynamicConfig();

  // Use UTC noon for date arithmetic to avoid timezone rollover issues
  const now = new Date();
  const todayIso = forceDate ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const today = new Date(todayIso + 'T12:00:00Z');
  const anchor = new Date(config.lastPayDate + 'T12:00:00Z');
  const freq = config.payFrequencyDays;

  if (!forceDate && !isPayday(today, anchor, freq)) {
    logger.debug('Not a payday — skipping allocation');
    return;
  }

  const ordinal = getPaydayOrdinalInMonth(today, anchor, freq);
  const month = todayIso.slice(0, 7); // Local date, not UTC

  if (ordinal === 3) {
    logger.info('Third paycheck of the month — skipping automatic allocation');
    const thread = await getOrCreateThread(discord, secrets.discordBudgetChannelId, `Payday #3 — ${month}`);
    await postToThread(discord, thread.id, 'Third paycheck this month — allocate surplus manually (e.g., emergency fund).');
    return;
  }

  const next = nextPayday(today, anchor, freq);

  const targets = getTargets(db);
  const allocated: { name: string; amount: number; type: string }[] = [];
  const skipped: string[] = [];
  const failed: { name: string; error: string }[] = [];

  // Single withActual session for all reads AND writes to avoid redundant syncs
  try {
    await withActual(
      ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      async () => {
        const categories = await getBudgetStatus(month);
        const scheduled = await getScheduledTransactions();

        for (const target of targets) {
          const live = categories.find((c) => c.id === target.categoryId);
          if (!live) continue;

          const matchedSchedule = scheduled.find((s) => s.category === live.name);
          let allocationAmount: number;
          let allocationType: string;

          if (matchedSchedule) {
            const dueDate = new Date(matchedSchedule.nextDate);
            if (dueDate > next) {
              continue; // Due after next payday — skip
            }
            allocationAmount = target.targetAmount;
            allocationType = 'fixed';
          } else {
            // Discretionary
            if (ordinal === 1) {
              allocationAmount = Math.ceil(target.targetAmount / 2);
            } else {
              allocationAmount = target.targetAmount;
            }
            allocationType = 'discretionary';
          }

          if (live.budgeted >= allocationAmount) {
            skipped.push(live.name);
            continue;
          }

          try {
            await allocateBudget(month, target.categoryId, allocationAmount);
            allocated.push({ name: live.name, amount: allocationAmount, type: allocationType });
          } catch (err) {
            failed.push({ name: live.name, error: String(err) });
            logger.error('Failed to allocate budget', { category: live.name, err: String(err) });
          }
        }
      }
    );
  } catch (err) {
    logger.error('Actual unreachable (allocation)', { err: String(err) });
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    await errChannel?.send('⚠️ Could not reach Actual Budget for pay-period allocation.').catch(() => {});
    return;
  }

  const fixedTotal = allocated.filter((a) => a.type === 'fixed').reduce((s, a) => s + a.amount, 0);
  const discTotal = allocated.filter((a) => a.type === 'discretionary').reduce((s, a) => s + a.amount, 0);
  const total = fixedTotal + discTotal;

  const summary = [
    `**Payday allocation complete (paycheck #${ordinal}):**`,
    `Fixed bills: ${allocated.filter((a) => a.type === 'fixed').length} categories, $${(fixedTotal / 100).toFixed(2)}`,
    `Discretionary: ${allocated.filter((a) => a.type === 'discretionary').length} categories, $${(discTotal / 100).toFixed(2)}`,
    skipped.length > 0 ? `Skipped (already funded): ${skipped.length}` : null,
    failed.length > 0 ? `⚠️ Failed: ${failed.map((f) => f.name).join(', ')}` : null,
    `**Total allocated: $${(total / 100).toFixed(2)}**`,
  ].filter(Boolean).join('\n');

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const thread = await getOrCreateThread(discord, secrets.discordBudgetChannelId, `Payday allocation — ${date}`);
  await postToThread(discord, thread.id, summary);

  logger.info('Pay-period allocation complete', {
    ordinal, allocated: allocated.length, skipped: skipped.length, failed: failed.length, total,
  });
}
