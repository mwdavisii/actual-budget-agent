import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';
import {
  createProposal,
  getPendingProposals,
  updateProposalStatus,
  updateProposalMessageId,
  expireStaleProposals,
  hasActiveProposal,
  setProposalTtl,
  getProposalTtl,
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

describe('hasActiveProposal', () => {
  it('returns true when a pending proposal exists for the txId', () => {
    const db = makeDb();
    createProposal(db, { id: 'p5', txId: 'tx5', category: 'Groceries', reason: 'food', threadId: 't5', messageId: 'm5' });
    expect(hasActiveProposal(db, 'tx5')).toBe(true);
  });

  it('returns false when no proposal exists for the txId', () => {
    const db = makeDb();
    expect(hasActiveProposal(db, 'tx-nonexistent')).toBe(false);
  });

  it('returns false when proposal has been approved', () => {
    const db = makeDb();
    createProposal(db, { id: 'p6', txId: 'tx6', category: 'Gas', reason: 'fuel', threadId: 't6', messageId: 'm6' });
    updateProposalStatus(db, 'p6', 'approved');
    expect(hasActiveProposal(db, 'tx6')).toBe(false);
  });

  it('returns false when proposal has been rejected', () => {
    const db = makeDb();
    createProposal(db, { id: 'p7', txId: 'tx7', category: 'Gas', reason: 'fuel', threadId: 't7', messageId: 'm7' });
    updateProposalStatus(db, 'p7', 'rejected');
    expect(hasActiveProposal(db, 'tx7')).toBe(false);
  });

  it('returns false when proposal has expired', () => {
    const db = makeDb();
    createProposal(db, { id: 'p8', txId: 'tx8', category: 'Gas', reason: 'fuel', threadId: 't8', messageId: 'm8' });
    db.prepare('UPDATE pending_proposals SET expires_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 1, 'p8');
    expect(hasActiveProposal(db, 'tx8')).toBe(false);
  });
});

describe('configurable TTL', () => {
  const originalTtl = getProposalTtl();

  afterEach(() => {
    setProposalTtl(originalTtl);
  });

  it('defaults to 24 hours', () => {
    expect(getProposalTtl()).toBe(24 * 60 * 60);
  });

  it('can be changed via setProposalTtl', () => {
    setProposalTtl(3600);
    expect(getProposalTtl()).toBe(3600);
  });

  it('uses configured TTL for new proposals', () => {
    setProposalTtl(60); // 1 minute
    const db = makeDb();
    createProposal(db, { id: 'p9', txId: 'tx9', category: 'Gas', reason: 'fuel', threadId: 't9', messageId: 'm9' });
    const proposal = getPendingProposals(db)[0];
    const now = Math.floor(Date.now() / 1000);
    // expires_at should be roughly now + 60 seconds
    expect(proposal.expiresAt).toBeGreaterThan(now + 50);
    expect(proposal.expiresAt).toBeLessThanOrEqual(now + 70);
  });
});
