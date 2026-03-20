import type Database from 'better-sqlite3';

const DEFAULT_proposalTtlSeconds = 24 * 60 * 60;
let proposalTtlSeconds = DEFAULT_proposalTtlSeconds;

export function setProposalTtl(seconds: number): void {
  proposalTtlSeconds = seconds;
}

export function getProposalTtl(): number {
  return proposalTtlSeconds;
}

export interface Proposal {
  id: string;
  txId: string;
  category: string;
  reason: string;
  threadId: string;
  messageId: string;
  status: string;
  expiresAt: number;
}

export function createProposal(
  db: Database.Database,
  p: Omit<Proposal, 'status' | 'expiresAt'>
): void {
  const expiresAt = Math.floor(Date.now() / 1000) + proposalTtlSeconds;
  db.prepare(`
    INSERT INTO pending_proposals (id, tx_id, category, reason, thread_id, message_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, p.txId, p.category, p.reason, p.threadId, p.messageId, expiresAt);
}

export function getPendingProposals(db: Database.Database): Proposal[] {
  return (
    db.prepare("SELECT * FROM pending_proposals WHERE status = 'pending'").all() as Array<{
      id: string; tx_id: string; category: string; reason: string;
      thread_id: string; message_id: string; status: string; expires_at: number;
    }>
  ).map((r) => ({
    id: r.id, txId: r.tx_id, category: r.category, reason: r.reason,
    threadId: r.thread_id, messageId: r.message_id, status: r.status, expiresAt: r.expires_at,
  }));
}

export function hasActiveProposal(db: Database.Database, txId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(
    "SELECT 1 FROM pending_proposals WHERE tx_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).get(txId, now);
  return row != null;
}

export function updateProposalStatus(
  db: Database.Database,
  id: string,
  status: 'approved' | 'rejected' | 'skipped' | 'expired'
): void {
  db.prepare('UPDATE pending_proposals SET status = ? WHERE id = ?').run(status, id);
}

export function updateProposalMessageId(db: Database.Database, id: string, messageId: string): void {
  db.prepare('UPDATE pending_proposals SET message_id = ? WHERE id = ?').run(messageId, id);
}

export function expireStaleProposals(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE pending_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?"
  ).run(now);
}
