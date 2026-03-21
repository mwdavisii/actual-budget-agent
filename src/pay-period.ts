/**
 * All date arithmetic uses UTC to avoid timezone-related off-by-one errors.
 * Callers should construct dates at UTC noon (e.g., new Date('YYYY-MM-DDT12:00:00Z'))
 * to avoid midnight rollover issues.
 */

export function isPayday(today: Date, lastPayDate: Date, frequencyDays: number): boolean {
  const diffMs = today.getTime() - lastPayDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays % frequencyDays === 0;
}

export function nextPayday(today: Date, lastPayDate: Date, frequencyDays: number): Date {
  const next = new Date(lastPayDate);
  while (next <= today) {
    next.setUTCDate(next.getUTCDate() + frequencyDays);
  }
  return next;
}

export function getPaydayOrdinalInMonth(
  today: Date, lastPayDate: Date, frequencyDays: number
): 1 | 2 | 3 {
  // Find the first payday of today's month
  let d = new Date(lastPayDate);

  // Walk forward to reach today's month
  while (d < today) {
    const next = new Date(d);
    next.setUTCDate(next.getUTCDate() + frequencyDays);
    if (next > today) break;
    d = next;
  }

  // Walk back to find the first payday of this month
  while (d.getUTCMonth() === today.getUTCMonth() && d.getUTCFullYear() === today.getUTCFullYear()) {
    const prev = new Date(d);
    prev.setUTCDate(prev.getUTCDate() - frequencyDays);
    if (prev.getUTCMonth() !== today.getUTCMonth() || prev.getUTCFullYear() !== today.getUTCFullYear()) break;
    d = prev;
  }

  // d is now the first payday of the month. Count forward to today.
  let ordinal = 1;
  const cursor = new Date(d);
  while (true) {
    cursor.setUTCDate(cursor.getUTCDate() + frequencyDays);
    if (cursor.getUTCMonth() !== today.getUTCMonth() || cursor > today) break;
    ordinal++;
  }

  return Math.min(ordinal, 3) as 1 | 2 | 3;
}
