import { describe, it, expect } from 'vitest';
import { toCsv } from '../../../src/actual/csv';

describe('toCsv', () => {
  it('joins plain values with commas and trailing newline', () => {
    const csv = toCsv(['A', 'B'], [['1', '2'], ['3', '4']]);
    expect(csv).toBe('A,B\n1,2\n3,4\n');
  });

  it('quotes fields containing a comma', () => {
    const csv = toCsv(['Name'], [['Smith, John']]);
    expect(csv).toBe('Name\n"Smith, John"\n');
  });

  it('quotes fields containing a double quote and escapes the quote', () => {
    const csv = toCsv(['Q'], [['He said "hi"']]);
    expect(csv).toBe('Q\n"He said ""hi"""\n');
  });

  it('quotes fields containing a newline', () => {
    const csv = toCsv(['Note'], [['line1\nline2']]);
    expect(csv).toBe('Note\n"line1\nline2"\n');
  });

  it('returns header-only CSV when rows is empty', () => {
    const csv = toCsv(['A', 'B'], []);
    expect(csv).toBe('A,B\n');
  });

  it('escapes special characters in headers the same way as data', () => {
    const csv = toCsv(['has,comma'], [['v']]);
    expect(csv).toBe('"has,comma"\nv\n');
  });
});
