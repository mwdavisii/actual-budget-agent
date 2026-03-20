import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import { getSession, saveSession, archiveExpiredSessions } from '../../../src/db/sessions';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

describe('sessions', () => {
  it('returns null for unknown thread', () => {
    const db = makeDb();
    expect(getSession(db, 'thread-1')).toBeNull();
  });

  it('saves and retrieves session messages', () => {
    const db = makeDb();
    const messages = [{ role: 'user', content: 'hello' }];
    saveSession(db, 'thread-1', messages);
    const result = getSession(db, 'thread-1');
    expect(result).toEqual(messages);
  });

  it('archives sessions older than TTL', () => {
    const db = makeDb();
    saveSession(db, 'old-thread', []);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE thread_id = ?')
      .run(Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60, 'old-thread');
    archiveExpiredSessions(db, 7);
    expect(getSession(db, 'old-thread')).toBeNull();
    const archived = db.prepare('SELECT * FROM archived_sessions WHERE thread_id = ?').get('old-thread');
    expect(archived).toBeTruthy();
  });
});
