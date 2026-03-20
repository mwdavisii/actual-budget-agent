import { getDb } from './db/client';
import { runMigrations } from './db/schema';
import { archiveExpiredSessions } from './db/sessions';
import { getPendingProposals, updateProposalMessageId, expireStaleProposals } from './db/proposals';
import { getSecrets } from './config';
import { createDiscordClient, loginDiscord } from './discord/client';
import { createWebhookServer } from './webhook/server';
import { registerMessageHandler } from './discord/router';
import { registerInteractionHandler } from './discord/interactions';
import { initAppContext } from './agent/index';
import { createEmailClient } from './email/client';
import { postApprovalMessage, editMessage } from './discord/threads';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';
import type { ThreadChannel } from 'discord.js';
import type { ActualConfig } from './agent/tools';

async function main() {
  logger.info('Budget agent starting');

  const secrets = getSecrets();
  const db = getDb(secrets.dataDir);
  runMigrations(db);
  archiveExpiredSessions(db, 7);
  expireStaleProposals(db);

  const discord = createDiscordClient();
  const emailTransporter = createEmailClient({
    host: secrets.smtpHost,
    port: secrets.smtpPort,
  });
  const anthropic = new Anthropic({ apiKey: secrets.claudeApiKey });

  const actualConfig: ActualConfig = {
    dataDir: secrets.dataDir,
    budgetId: secrets.actualBudgetId,
    serverUrl: secrets.actualServerUrl,
    password: secrets.actualPassword,
  };

  initAppContext({ discord, db, secrets, emailTransporter, actualConfig, anthropic });

  await loginDiscord(discord, secrets.discordToken);
  await new Promise<void>((resolve) => discord.once('ready', () => resolve()));
  logger.info('Discord client ready');

  // SEQUENTIAL: re-post pending proposals BEFORE registering interaction listener
  const pending = getPendingProposals(db);
  logger.info('Re-posting pending proposals', { count: pending.length });

  for (const proposal of pending) {
    try {
      const thread = await discord.channels.fetch(proposal.threadId) as ThreadChannel | null;
      if (!thread) { logger.warn('Thread not found', { proposalId: proposal.id }); continue; }
      if (thread.archived) await thread.setArchived(false);

      await editMessage(discord, proposal.threadId, proposal.messageId, '⟳ Re-posted above');

      const content = `**Category Proposal (re-posted)**\nTransaction: \`${proposal.txId}\`\nCategory: **${proposal.category}**\nReason: ${proposal.reason}`;
      const newMsg = await postApprovalMessage(thread, content);
      updateProposalMessageId(db, proposal.id, newMsg.id);
    } catch (err) {
      logger.error('Failed to re-post proposal', { proposalId: proposal.id, err: String(err) });
    }
  }

  // NOW register listeners — no race with re-post loop
  registerInteractionHandler(discord, db, secrets, actualConfig);
  registerMessageHandler(discord, secrets);

  const webhookCtx = {
    hmacKey: secrets.webhookHmacKey,
    dataDir: secrets.dataDir,
    budgetId: actualConfig.budgetId,
    actualServerUrl: actualConfig.serverUrl,
    actualPassword: actualConfig.password,
  };
  const { app, setReady } = createWebhookServer(webhookCtx);
  const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
  app.listen(PORT, () => {
    logger.info('Webhook server listening', { port: PORT });
    setReady();
  });

  // Hourly maintenance
  setInterval(() => {
    expireStaleProposals(db);
    archiveExpiredSessions(db, 7);
    logger.debug('Ran hourly maintenance');
  }, 60 * 60 * 1000);

  logger.info('Budget agent startup complete');
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'critical', message: 'Fatal startup error', err: String(err) }));
  process.exit(1);
});
