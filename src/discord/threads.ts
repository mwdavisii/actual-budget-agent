import {
  Client, TextChannel, ThreadChannel, Message,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { logger } from '../logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getOrCreateThread(
  client: Client,
  channelId: string,
  threadName: string
): Promise<ThreadChannel> {
  const channel = await client.channels.fetch(channelId) as TextChannel;
  return channel.threads.create({
    name: threadName.slice(0, 100),
    autoArchiveDuration: 10080,
  });
}

export async function postToThread(
  client: Client,
  threadId: string,
  content: string
): Promise<Message> {
  let thread = await client.channels.fetch(threadId) as ThreadChannel;
  if (thread.archived) {
    await thread.setArchived(false);
    logger.info('Unarchived thread', { threadId });
  }
  return thread.send({ content });
}

export async function postApprovalMessage(
  thread: ThreadChannel,
  content: string
): Promise<Message> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('reject').setLabel('Reject').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary)
  );
  return thread.send({ content, components: [row] });
}

export async function editMessage(
  client: Client,
  channelId: string,
  messageId: string,
  newContent: string
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId) as ThreadChannel;
    const message = await channel.messages.fetch(messageId);
    await message.edit({ content: newContent, components: [] });
  } catch (err) {
    logger.warn('Could not edit message', { channelId, messageId, err: String(err) });
  }
}

/** Post a batch of Discord messages with 1-second delay between each to respect rate limits. */
export async function postBatch(fns: Array<() => Promise<void>>): Promise<void> {
  for (let i = 0; i < fns.length; i++) {
    await fns[i]();
    if (i < fns.length - 1) await sleep(1000);
  }
}
