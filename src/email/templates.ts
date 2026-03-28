import type { CategoryStatus } from '../actual/queries';

function dollars(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function buildWeeklyDigest(
  categories: CategoryStatus[],
  totalSpentCents: number
): { subject: string; body: string } {
  const sorted = [...categories].sort((a, b) => b.spent - a.spent);
  const top = sorted[0];
  const narrative = `You spent ${dollars(totalSpentCents)} this week. ${top.name} was your biggest category at ${dollars(top.spent)}.`;

  const lines = categories
    .map((c) => {
      if (c.available < 0) {
        return `  ${c.name}: spent ${dollars(c.spent)} — over by ${dollars(c.available)}`;
      }
      return `  ${c.name}: spent ${dollars(c.spent)} — ${dollars(c.available)} remaining`;
    })
    .join('\n');

  const body = [narrative, '', 'Category Breakdown:', lines].join('\n');
  return { subject: 'Your Weekly Budget Summary', body };
}

export function buildOverspendAlert(
  categoryName: string,
  overageCents: number,
  availableCents: number
): { subject: string; body: string } {
  return {
    subject: `Budget Alert: ${categoryName} is over budget`,
    body: [
      `${categoryName} has exceeded its budget by ${dollars(overageCents)}.`,
      `Current balance: ${dollars(availableCents)} (negative = over budget).`,
      '',
      'No action needed — just a heads up!',
    ].join('\n'),
  };
}
