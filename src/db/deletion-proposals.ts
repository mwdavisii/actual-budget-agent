import type Database from 'better-sqlite3';
import { getProposalTtl } from './proposals';

export interface DeletionProposal {
  id: string;
  txId: string;
  matchedTxId: string;
  threadId: string;
  messageId: string;
  status: string;
  expiresAt: number;
}

export function createDeletionProposal(
  db: Database.Database,
  p: Omit<DeletionProposal, 'status' | 'expiresAt'>
): void {
  const expiresAt = Math.floor(Date.now() / 1000) + getProposalTtl();
  db.prepare(`
    INSERT INTO pending_proposals (id, tx_id, category, reason, thread_id, message_id, expires_at, type, matched_tx_id)
    VALUES (?, ?, 'deletion', 'stale pending', ?, ?, ?, 'deletion', ?)
  `).run(p.id, p.txId, p.threadId, p.messageId, expiresAt, p.matchedTxId);
}

export function hasActiveDeletionProposal(db: Database.Database, txId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(
    "SELECT 1 FROM pending_proposals WHERE tx_id = ? AND type = 'deletion' AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).get(txId, now);
  return row != null;
}
