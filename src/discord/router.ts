import type { Client, Message } from 'discord.js';
import { enqueueMessage } from '../agent/session';
import { runAgent } from '../agent/index';
import { postToThread, editMessage, getOrCreateThread } from './threads';
import { parseCommand, executeCommand, type CommandContext } from './commands';
import { logger } from '../logger';
import type { SecretsConfig } from '../config';
import type { WebhookContext } from '../webhook/server';

export function registerMessageHandler(client: Client, secrets: SecretsConfig, webhookCtx: WebhookContext): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (message.author.id !== secrets.discordAllowedUserId) return;

    let threadId: string;

    if (message.channel.isThread()) {
      threadId = message.channel.id;
    } else if (message.channelId === secrets.discordBudgetChannelId) {
      const thread = await getOrCreateThread(
        client,
        secrets.discordBudgetChannelId,
        message.content.slice(0, 50) || 'Budget conversation'
      );
      threadId = thread.id;
    } else {
      return;
    }

    logger.info('Message received', { threadId });

    // Check for prefix commands first — these work without the LLM
    const parsed = parseCommand(message.content);
    if (parsed) {
      const cmdCtx: CommandContext = { client, threadId, webhookCtx };
      try {
        await executeCommand(parsed.name, cmdCtx, parsed.args);
      } catch (err) {
        logger.error('Command handler error', { command: parsed.name, threadId, err: String(err) });
        await postToThread(client, threadId, `Command failed: ${String(err)}`).catch(() => {});
      }
      return;
    }

    if (!secrets.enableLlm) {
      await postToThread(client, threadId, 'LLM is disabled. Use `!help` to see available commands.');
      return;
    }

    try {
      const ack = await postToThread(client, threadId, '⏳ On it…');
      const reply = await enqueueMessage(
        threadId,
        message.content,
        (tid, msg) => runAgent(tid, msg),
        async () => {
          await postToThread(client, threadId, '⚠️ Too many messages queued — please wait for my current response.');
        }
      );
      await editMessage(client, threadId, ack.id, reply);
    } catch (err) {
      logger.error('Message handler error', { threadId, err: String(err) });
    }
  });
}
