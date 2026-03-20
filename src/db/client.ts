import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../logger';

let db: Database.Database | null = null;

export function getDb(dataDir: string): Database.Database {
  if (db) return db;
  const dbPath = path.join(dataDir, 'sessions.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  logger.info('SQLite opened', { path: dbPath, mode: 'WAL' });
  return db;
}
