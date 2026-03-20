import { logger } from '../logger';

const MAX_QUEUE_DEPTH = 10;
const QUEUE_TTL_MS = 5 * 60 * 1000;

interface QueueEntry {
  message: string;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const queues = new Map<string, QueueEntry[]>();
const inFlight = new Set<string>();

export async function enqueueMessage(
  threadId: string,
  message: string,
  processMessage: (threadId: string, message: string) => Promise<string>,
  notifyOverflow: () => Promise<void>
): Promise<string> {
  if (!inFlight.has(threadId)) {
    return processWithDrain(threadId, message, processMessage);
  }

  const queue = queues.get(threadId) ?? [];
  if (queue.length >= MAX_QUEUE_DEPTH) {
    logger.warn('Session queue overflow', { threadId });
    await notifyOverflow();
    throw new Error('Queue full');
  }

  return new Promise<string>((resolve, reject) => {
    queue.push({ message, resolve, reject, enqueuedAt: Date.now() });
    queues.set(threadId, queue);
  });
}

async function processWithDrain(
  threadId: string,
  message: string,
  processMessage: (threadId: string, message: string) => Promise<string>
): Promise<string> {
  inFlight.add(threadId);
  try {
    return await processMessage(threadId, message);
  } finally {
    // Remove the in-flight flag BEFORE draining so drainQueue's recursive
    // processWithDrain call can re-set it without the outer finally clearing it.
    inFlight.delete(threadId);
    drainQueue(threadId, processMessage);
  }
}

function drainQueue(
  threadId: string,
  processMessage: (threadId: string, message: string) => Promise<string>
): void {
  const queue = queues.get(threadId) ?? [];
  const now = Date.now();
  while (queue.length > 0 && now - queue[0].enqueuedAt > QUEUE_TTL_MS) {
    queue.shift()?.reject(new Error('Queue entry expired'));
  }
  const next = queue.shift();
  if (!next) { queues.delete(threadId); return; }
  queues.set(threadId, queue);
  processWithDrain(threadId, next.message, processMessage)
    .then(next.resolve)
    .catch(next.reject);
}
