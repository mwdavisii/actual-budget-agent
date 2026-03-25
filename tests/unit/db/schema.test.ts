import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';

describe('cleanup_state migration', () => {
  it('creates cleanup_state table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_state'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });
});
