import type { WebhookContext } from '../server';
import type { ThreadChannel } from 'discord.js';
import { withActual } from '../../actual/client';
import { findStalePendingTransactions, type StalePendingMatch } from '../../actual/stale-pending';
import { getAppContext } from '../../agent/index';
import { getOrCreateThread, postToThread, postDeletionApprovalMessage } from '../../discord/threads';
import { createDeletionProposal, hasActiveDeletionProposal } from '../../db/deletion-proposals';
import { randomUUID } from 'crypto';
import { logger } from '../../logger';

export async function handleStalePending(ctx: WebhookContext): Promise<void> {
  const { discord, secrets, db } = getAppContext();

  let matches: StalePendingMatch[];
  try {
    matches = await withActual(
      ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword,
      findStalePendingTransactions
    );
  } catch (err) {
    logger.error('Actual unreachable (stale pending)', { err: String(err) });
    const errChannel = await discord.channels.fetch(secrets.discordErrorChannelId).catch(() => null) as any;
    await errChannel?.send('⚠️ Could not reach Actual Budget for stale pending check.').catch(() => {});
    return;
  }

  if (matches.length === 0) {
    logger.info('No stale pending transactions found');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const thread = await getOrCreateThread(
    discord,
    secrets.discordBudgetChannelId,
    `Stale pending transactions — ${date}`
  );

  await postToThread(discord, thread.id,
    `Found ${matches.length} stale pending transaction${matches.length > 1 ? 's' : ''} with cleared counterparts:`
  );

  let posted = 0;
  for (const match of matches) {
    if (hasActiveDeletionProposal(db, match.pending.id)) {
      logger.info('Skipping — active deletion proposal exists', { txId: match.pending.id });
      continue;
    }

    const pendingAmount = `$${(Math.abs(match.pending.amount) / 100).toFixed(2)}`;
    const clearedAmount = `$${(Math.abs(match.cleared.amount) / 100).toFixed(2)}`;
    const pendingAge = Math.floor(
      (Date.now() - new Date(match.pending.date).getTime()) / (1000 * 60 * 60 * 24)
    );

    const content = [
      '**Stale Pending Transaction**',
      `Payee: **${match.pending.payeeName}**`,
      `Account: **${match.pending.accountName}**`,
      `Category: **${match.pending.categoryName}**`,
      '',
      '**Pending (to delete):**',
      `> Date: ${match.pending.date} (${pendingAge} days ago)`,
      `> Amount: ${pendingAmount}`,
      `> ID: \`${match.pending.id}\``,
      '',
      '**Cleared (kept):**',
      `> Date: ${match.cleared.date}`,
      `> Amount: ${clearedAmount}`,
      `> ID: \`${match.cleared.id}\``,
      '',
      `Action: **Delete pending transaction**`,
    ].join('\n');

    const threadChannel = await discord.channels.fetch(thread.id) as ThreadChannel;
    const message = await postDeletionApprovalMessage(threadChannel, content);

    const proposalId = randomUUID();
    createDeletionProposal(db, {
      id: proposalId,
      txId: match.pending.id,
      matchedTxId: match.cleared.id,
      threadId: thread.id,
      messageId: message.id,
    });

    posted++;
    logger.info('Deletion proposal posted', { proposalId, txId: match.pending.id, matchedTxId: match.cleared.id });
  }

  if (posted > 0) {
    await postToThread(discord, thread.id,
      `Posted ${posted} deletion proposal${posted > 1 ? 's' : ''}. Approve to delete the stale pending transaction.`
    );
  }
}
