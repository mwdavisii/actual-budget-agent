import type { Client, Interaction } from 'discord.js';
import { updateProposalStatus } from '../db/proposals';
import { setCategoryForTransaction } from '../actual/queries';
import { withActual } from '../actual/client';
import { postToThread, editMessage } from './threads';
import { logger } from '../logger';
import type Database from 'better-sqlite3';
import type { SecretsConfig } from '../config';
import type { ActualConfig } from '../agent/tools';

// Internal only — NOT exported, NOT callable by the model
async function applyCategory(txId: string, category: string, actualConfig: ActualConfig): Promise<void> {
  await withActual(
    actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password,
    () => setCategoryForTransaction(txId, category)
  );
  logger.info('Category applied', { txId, category });
}

export function registerInteractionHandler(
  client: Client,
  db: Database.Database,
  secrets: SecretsConfig,
  actualConfig: ActualConfig
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== secrets.discordAllowedUserId) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }

    const messageId = interaction.message.id;
    const proposal = db
      .prepare("SELECT * FROM pending_proposals WHERE message_id = ? AND status = 'pending'")
      .get(messageId) as { id: string; tx_id: string; category: string; thread_id: string } | undefined;

    if (!proposal) {
      await interaction.reply({ content: 'This proposal has already been resolved or expired.', ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    const originalContent = interaction.message.content;

    switch (interaction.customId) {
      case 'approve':
        try {
          await applyCategory(proposal.tx_id, proposal.category, actualConfig);
          updateProposalStatus(db, proposal.id, 'approved');
          await editMessage(client, proposal.thread_id, messageId, `${originalContent}\n\n**Decision: ✅ Approved**`);
          await postToThread(client, proposal.thread_id, `✅ Categorized \`${proposal.tx_id}\` as **${proposal.category}**.`);
        } catch (err) {
          logger.error('applyCategory failed', { proposalId: proposal.id, err: String(err) });
          await postToThread(client, proposal.thread_id, `⚠️ Failed to apply: ${String(err)}`);
        }
        break;
      case 'reject':
        updateProposalStatus(db, proposal.id, 'rejected');
        await editMessage(client, proposal.thread_id, messageId, `${originalContent}\n\n**Decision: ❌ Rejected**`);
        await postToThread(client, proposal.thread_id, `❌ Proposal rejected for \`${proposal.tx_id}\`.`);
        break;
      case 'skip':
        updateProposalStatus(db, proposal.id, 'skipped');
        await editMessage(client, proposal.thread_id, messageId, `${originalContent}\n\n**Decision: ⏭️ Skipped**`);
        break;
    }
  });
}
