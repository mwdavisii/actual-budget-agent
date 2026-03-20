import { buildWeeklyDigest, buildOverspendAlert } from '../../../src/email/templates';

const categories = [
  { id: '1', name: 'Groceries', budgeted: 50000, spent: 32000, available: 18000 },
  { id: '2', name: 'Dining Out', budgeted: 20000, spent: 25000, available: -5000 },
  { id: '3', name: "Natalie's Spending", budgeted: 10000, spent: 6000, available: 4000 },
];

describe('buildWeeklyDigest', () => {
  it('includes total spending in narrative', () => {
    const { subject, body } = buildWeeklyDigest(categories, 63000);
    expect(subject).toMatch(/weekly/i);
    expect(body).toMatch(/\$630\.00/);
  });

  it('marks overspent category as Over Budget', () => {
    const { body } = buildWeeklyDigest(categories, 63000);
    expect(body).toMatch(/Dining Out/);
    expect(body).toMatch(/Over Budget/);
  });

  it('marks on-track category as On Track', () => {
    const { body } = buildWeeklyDigest(categories, 63000);
    expect(body).toMatch(/Groceries/);
    expect(body).toMatch(/On Track/);
  });
});

describe('buildOverspendAlert', () => {
  it('names the category and overage amount', () => {
    const { subject, body } = buildOverspendAlert('Dining Out', 5000, -5000);
    expect(subject).toMatch(/Dining Out/);
    expect(body).toMatch(/\$50\.00/);
  });
});
