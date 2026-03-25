import type { Client, Message } from 'discord.js';
import { enqueueMessage } from '../agent/session';
import { runAgent } from '../agent/index';
import { postToThread, editMessage, getOrCreateThread } from './threads';
import { logger } from '../logger';
import type { SecretsConfig } from '../config';

export function registerMessageHandler(client: Client, secrets: SecretsConfig): void {
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
