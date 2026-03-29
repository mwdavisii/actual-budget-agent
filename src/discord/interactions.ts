import type { Client, Interaction } from 'discord.js';
import { updateProposalStatus } from '../db/proposals';
import { setCategoryForTransaction } from '../actual/queries';
import { withActual } from '../actual/client';
import { postToThread, editMessage } from './threads';
import { handleCleanupInteraction } from './cleanup-flow';
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

    // Handle cleanup flow buttons
    if (await handleCleanupInteraction(interaction, client)) return;

    // Handle deletion proposal buttons
    const deletionCustomIds = ['approve_delete', 'reject_delete', 'skip_delete'];
    if (deletionCustomIds.includes(interaction.customId)) {
      const msgId = interaction.message.id;
      const deletionProposal = db
        .prepare("SELECT * FROM pending_proposals WHERE message_id = ? AND type = 'deletion' AND status = 'pending'")
        .get(msgId) as { id: string; tx_id: string; matched_tx_id: string; thread_id: string } | undefined;

      if (!deletionProposal) {
        await interaction.reply({ content: 'This proposal has already been resolved or expired.', ephemeral: true });
        return;
      }

      await interaction.deferUpdate();
      const origContent = interaction.message.content;

      switch (interaction.customId) {
        case 'approve_delete':
          try {
            await withActual(
              actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password,
              async () => {
                const { actualApi: api } = await import('../actual/client');
                await api.deleteTransaction(deletionProposal.tx_id);
              }
            );
            updateProposalStatus(db, deletionProposal.id, 'approved');
            await editMessage(client, deletionProposal.thread_id, msgId, `${origContent}\n\n**Decision: ✅ Deleted**`);
            await postToThread(client, deletionProposal.thread_id, `✅ Deleted stale pending transaction \`${deletionProposal.tx_id}\`.`);
          } catch (err) {
            logger.error('Delete transaction failed', { proposalId: deletionProposal.id, err: String(err) });
            await postToThread(client, deletionProposal.thread_id, `⚠️ Failed to delete: ${String(err)}`);
          }
          break;
        case 'reject_delete':
          updateProposalStatus(db, deletionProposal.id, 'rejected');
          await editMessage(client, deletionProposal.thread_id, msgId, `${origContent}\n\n**Decision: ❌ Rejected**`);
          await postToThread(client, deletionProposal.thread_id, `❌ Deletion rejected for \`${deletionProposal.tx_id}\`.`);
          break;
        case 'skip_delete':
          updateProposalStatus(db, deletionProposal.id, 'skipped');
          await editMessage(client, deletionProposal.thread_id, msgId, `${origContent}\n\n**Decision: ⏭️ Skipped**`);
          break;
      }
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
