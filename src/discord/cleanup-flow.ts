import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
  type Client, type ThreadChannel, type Interaction,
} from 'discord.js';
import { getRollingPruneCutoff, pruneTransactions, cleanupHiddenCategories, cleanupClosedAccounts } from '../actual/queries';
import { withActual, actualApi } from '../actual/client';
import { postToThread } from './threads';
import { logger } from '../logger';
import type Database from 'better-sqlite3';

export interface CleanupConfig {
  dataDir: string;
  budgetId: string;
  serverUrl: string;
  password: string;
}

interface DryRunResult {
  cutoff: string;
  months: number;
  transactions: { count: number; sample: string[] };
  categories: { count: number; names: string[] };
  accounts: { count: number; names: string[] };
  warnings: string[];
}

// Pending cleanup state keyed by message ID
const pendingCleanups = new Map<string, { config: CleanupConfig; result: DryRunResult; db: Database.Database }>();

export function formatDryRunMessage(result: DryRunResult): string {
  const lines = [
    `**Cleanup preview** (trimming to **${result.months} months**, cutoff: ${result.cutoff})`,
    '',
    `- **Transactions to delete:** ${result.transactions.count}`,
    `- **Hidden categories to delete:** ${result.categories.count}`,
    `- **Closed accounts to delete:** ${result.accounts.count}`,
  ];
  if (result.transactions.sample.length > 0) {
    lines.push('', '**Sample transactions:**', ...result.transactions.sample.map(s => `  ${s}`));
  }
  if (result.categories.names.length > 0) {
    lines.push('', '**Categories:** ' + result.categories.names.join(', '));
  }
  if (result.accounts.names.length > 0) {
    lines.push('', '**Accounts:** ' + result.accounts.names.join(', '));
  }
  if (result.warnings.length > 0) {
    lines.push('', '**Warnings:**', ...result.warnings.map(w => `- ${w}`));
  }
  return lines.join('\n');
}

function buildCleanupButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('cleanup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cleanup_export').setLabel('Export Backup').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cleanup_proceed').setLabel('Proceed').setStyle(ButtonStyle.Danger),
  );
}

function buildPostExportButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('cleanup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cleanup_proceed').setLabel('Proceed').setStyle(ButtonStyle.Danger),
  );
}

export async function startCleanupFlow(
  client: Client,
  threadId: string,
  months: number,
  config: CleanupConfig,
  db: Database.Database,
): Promise<DryRunResult> {
  const cutoff = getRollingPruneCutoff(months);

  const result = await withActual(config.dataDir, config.budgetId, config.serverUrl, config.password, async () => {
    const warnings: string[] = [];
    let transactions = { count: 0, sample: [] as string[] };
    let categories = { count: 0, names: [] as string[] };
    let accounts = { count: 0, names: [] as string[] };

    try {
      const pruneResult = await pruneTransactions(cutoff, true);
      transactions = { count: pruneResult.deleted, sample: pruneResult.sample };
    } catch (err) {
      warnings.push(`Transaction prune failed: ${String(err)}`);
    }
    try {
      const catResult = await cleanupHiddenCategories(true, cutoff);
      categories = { count: catResult.deleted, names: catResult.names };
      warnings.push(...catResult.warnings);
    } catch (err) {
      warnings.push(`Category cleanup failed: ${String(err)}`);
    }
    try {
      const accResult = await cleanupClosedAccounts(true, cutoff);
      accounts = { count: accResult.deleted, names: accResult.names };
      warnings.push(...accResult.warnings);
    } catch (err) {
      warnings.push(`Account cleanup failed: ${String(err)}`);
    }

    return { cutoff, months, transactions, categories, accounts, warnings } as DryRunResult;
  });

  const thread = await client.channels.fetch(threadId) as ThreadChannel;
  const message = await thread.send({
    content: formatDryRunMessage(result),
    components: [buildCleanupButtons()],
  });

  pendingCleanups.set(message.id, { config, result, db });

  return result;
}

export async function handleCleanupInteraction(
  interaction: Interaction,
  client: Client,
): Promise<boolean> {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith('cleanup_')) return false;

  const messageId = interaction.message.id;
  const pending = pendingCleanups.get(messageId);

  if (!pending) {
    await interaction.reply({ content: 'This cleanup session has expired.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();
  const threadId = interaction.message.channelId;

  switch (interaction.customId) {
    case 'cleanup_cancel': {
      pendingCleanups.delete(messageId);
      await interaction.message.edit({ content: interaction.message.content + '\n\n**Cancelled.**', components: [] });
      break;
    }

    case 'cleanup_export': {
      try {
        const exportResult = await withActual(
          pending.config.dataDir, pending.config.budgetId, pending.config.serverUrl, pending.config.password,
          async () => (actualApi as any).internal.send('export-budget') as Promise<{ data?: Buffer; error?: string }>
        );
        if (exportResult.error || !exportResult.data) {
          await postToThread(client, threadId, `Export failed: ${exportResult.error ?? 'no data returned'}`);
          break;
        }
        const dateStr = new Date().toISOString().slice(0, 10);
        const attachment = new AttachmentBuilder(exportResult.data, { name: `budget-backup-${dateStr}.zip` });
        const thread = await client.channels.fetch(threadId) as ThreadChannel;
        await thread.send({ content: `Budget backup — ${dateStr}`, files: [attachment] });
      } catch (err) {
        logger.error('Cleanup export failed', { err: String(err) });
        await postToThread(client, threadId, `Export failed: ${String(err)}`);
        break;
      }
      // Replace buttons with Cancel/Proceed (export done)
      await interaction.message.edit({
        content: interaction.message.content + '\n\n**Backup exported.** Ready to proceed?',
        components: [buildPostExportButtons()],
      });
      break;
    }

    case 'cleanup_proceed': {
      pendingCleanups.delete(messageId);
      await interaction.message.edit({ content: interaction.message.content + '\n\n**Executing cleanup...**', components: [] });

      const { config, result, db } = pending;
      const cutoff = result.cutoff;

      try {
        const execResult = await withActual(config.dataDir, config.budgetId, config.serverUrl, config.password, async () => {
          const warnings: string[] = [];
          let txCount = 0;
          let catCount = 0;
          let accCount = 0;

          let progressMsg: { edit: (opts: { content: string }) => Promise<void> } | null = null;
          const onProgress = async (count: number, total: number) => {
            const pct = Math.round((count / total) * 100);
            const content = `Deleting transactions: ${count.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
            try {
              if (!progressMsg) {
                const thread = await client.channels.fetch(threadId) as any;
                progressMsg = await thread.send({ content });
              } else {
                await progressMsg.edit({ content });
              }
            } catch (err) {
              logger.warn('Discord progress update failed', { error: String(err) });
            }
          };

          try {
            const pruneResult = await pruneTransactions(cutoff, false, db, false, onProgress);
            txCount = pruneResult.deleted;
          } catch (err) { warnings.push(`Transaction prune failed: ${String(err)}`); }
          try {
            const catResult = await cleanupHiddenCategories(false, cutoff);
            catCount = catResult.deleted;
            warnings.push(...catResult.warnings);
          } catch (err) { warnings.push(`Category cleanup failed: ${String(err)}`); }
          try {
            const accResult = await cleanupClosedAccounts(false, cutoff);
            accCount = accResult.deleted;
            warnings.push(...accResult.warnings);
          } catch (err) { warnings.push(`Account cleanup failed: ${String(err)}`); }

          return { txCount, catCount, accCount, warnings };
        });

        const lines = [
          '**Cleanup complete!**',
          `- ${execResult.txCount} transactions pruned`,
          `- ${execResult.catCount} hidden categories deleted`,
          `- ${execResult.accCount} closed accounts deleted`,
        ];
        if (execResult.warnings.length > 0) {
          lines.push('', '**Warnings:**', ...execResult.warnings.map(w => `- ${w}`));
        }
        await postToThread(client, threadId, lines.join('\n'));
      } catch (err) {
        logger.error('Cleanup execution failed', { err: String(err) });
        await postToThread(client, threadId, `Cleanup failed: ${String(err)}`);
      }
      break;
    }
  }

  return true;
}

/** For testing: clear all pending cleanups */
export function clearPendingCleanups(): void {
  pendingCleanups.clear();
}

/** For testing: check pending state */
export function getPendingCleanup(messageId: string) {
  return pendingCleanups.get(messageId);
}
