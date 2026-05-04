import { AttachmentBuilder, type Client } from 'discord.js';

export async function attachCsvToThread(
  client: Client,
  threadId: string,
  filename: string,
  csv: string,
): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: filename });
  const thread = await client.channels.fetch(threadId) as any;
  await thread.send({ content: filename.replace(/\.csv$/, ''), files: [attachment] });
}
