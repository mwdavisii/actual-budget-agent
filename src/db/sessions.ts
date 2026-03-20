import type Database from 'better-sqlite3';

type Message = { role: string; content: string };

export function getSession(db: Database.Database, threadId: string): Message[] | null {
  const row = db.prepare('SELECT messages FROM sessions WHERE thread_id = ?').get(threadId) as
    | { messages: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.messages) as Message[];
}

export function saveSession(db: Database.Database, threadId: string, messages: Message[]): void {
  db.prepare(`
    INSERT INTO sessions (thread_id, messages, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages, updated_at = unixepoch()
  `).run(threadId, JSON.stringify(messages));
}

export function archiveExpiredSessions(db: Database.Database, ttlDays: number): void {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 24 * 60 * 60;
  const expired = db.prepare('SELECT * FROM sessions WHERE updated_at < ?').all(cutoff) as Array<{
    thread_id: string;
    messages: string;
  }>;
  const archive = db.prepare(`
    INSERT OR REPLACE INTO archived_sessions (thread_id, messages) VALUES (?, ?)
  `);
  const del = db.prepare('DELETE FROM sessions WHERE thread_id = ?');
  const archiveTx = db.transaction(() => {
    for (const row of expired) {
      archive.run(row.thread_id, row.messages);
      del.run(row.thread_id);
    }
  });
  archiveTx();
}
