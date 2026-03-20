import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import {
  createProposal,
  getPendingProposals,
  updateProposalStatus,
  updateProposalMessageId,
  expireStaleProposals,
} from '../../../src/db/proposals';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

describe('proposals', () => {
  it('creates and retrieves a pending proposal', () => {
    const db = makeDb();
    createProposal(db, { id: 'p1', txId: 'tx1', category: 'Groceries', reason: 'food', threadId: 't1', messageId: 'm1' });
    const pending = getPendingProposals(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('p1');
    expect(pending[0].status).toBe('pending');
  });

  it('updates proposal status', () => {
    const db = makeDb();
    createProposal(db, { id: 'p2', txId: 'tx2', category: 'Dining Out', reason: 'restaurant', threadId: 't2', messageId: 'm2' });
    updateProposalStatus(db, 'p2', 'approved');
    expect(getPendingProposals(db)).toHaveLength(0);
  });

  it('updates message ID on restart re-post', () => {
    const db = makeDb();
    createProposal(db, { id: 'p3', txId: 'tx3', category: 'Gas', reason: 'fuel', threadId: 't3', messageId: 'old-msg' });
    updateProposalMessageId(db, 'p3', 'new-msg');
    expect(getPendingProposals(db)[0].messageId).toBe('new-msg');
  });

  it('expires stale proposals', () => {
    const db = makeDb();
    createProposal(db, { id: 'p4', txId: 'tx4', category: 'Gas', reason: 'fuel', threadId: 't4', messageId: 'm4' });
    db.prepare('UPDATE pending_proposals SET expires_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 1, 'p4');
    expireStaleProposals(db);
    expect(getPendingProposals(db)).toHaveLength(0);
  });
});
