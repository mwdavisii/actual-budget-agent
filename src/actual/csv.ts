import { actualApi } from './client';
import { getScheduledTransactions } from './queries';

function escapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const headerLine = headers.map(escapeField).join(',');
  const bodyLines = rows.map((r) => r.map(escapeField).join(','));
  return [headerLine, ...bodyLines].join('\n') + '\n';
}

export async function buildScheduledTransactionsCsv(): Promise<string> {
  const [schedules, payees, groups] = await Promise.all([
    getScheduledTransactions(),
    actualApi.getPayees(),
    actualApi.getCategoryGroups(),
  ]);

  const payeeMap = new Map<string, string>(
    (payees as Array<{ id: string; name: string }>).map((p) => [p.id, p.name])
  );
  const categoryMap = new Map<string, string>(
    (groups as Array<{ categories?: Array<{ id: string; name: string }> }>)
      .flatMap((g) => g.categories ?? [])
      .map((c) => [c.id, c.name])
  );

  const rows = schedules.map((s) => {
    const payeeName = payeeMap.get(s.payee) ?? '(unknown)';
    const categoryName = s.category ? (categoryMap.get(s.category) ?? '(uncategorized)') : '(uncategorized)';
    const amount = (s.amount / 100).toFixed(2);
    return [s.nextDate, payeeName, categoryName, amount] as [string, string, string, string];
  });

  rows.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });

  return toCsv(['Next Date', 'Payee', 'Category', 'Amount'], rows);
}
