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
