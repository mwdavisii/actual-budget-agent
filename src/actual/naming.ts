import { actualApi } from './client';

const UUID_PREFIX_RE = /^[0-9a-f]{8}-/i;

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) {
    previous[i] = i;
  }

  for (let j = 1; j <= b.length; j++) {
    let prevDiagonal = previous[0];
    previous[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const temp = previous[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[i] = Math.min(
        previous[i] + 1,
        previous[i - 1] + 1,
        prevDiagonal + cost
      );
      prevDiagonal = temp;
    }
  }

  return previous[a.length];
}

interface ScoredCandidate {
  name: string;
  tier: number;
  distance: number;
}

export function suggestClosest(input: string, candidates: string[], limit = 3): string[] {
  const normalizedInput = input.toLowerCase();
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    if (normalizedCandidate === normalizedInput) continue;

    let tier: number;
    if (normalizedCandidate.includes(normalizedInput)) {
      tier = 0;
    } else if (normalizedCandidate.startsWith(normalizedInput)) {
      tier = 1;
    } else {
      tier = 2;
    }

    scored.push({
      name: candidate,
      tier,
      distance: levenshtein(normalizedInput, normalizedCandidate),
    });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.name.localeCompare(b.name);
  });

  return scored.slice(0, limit).map((s) => s.name);
}

interface Category {
  id: string;
  name: string;
}

async function fetchCategories(): Promise<Category[]> {
  const groups = (await actualApi.getCategoryGroups()) as Array<{
    categories?: Array<{ id: string; name: string }>;
  }>;
  return groups.flatMap((g) => g.categories ?? []);
}

export async function resolveCategory(categoryNameOrId: string): Promise<{ id: string; name: string }> {
  const input = categoryNameOrId.trim();
  if (input === '') {
    throw new Error('Category cannot be empty — pass null to clear a category');
  }

  const categories = await fetchCategories();

  if (UUID_PREFIX_RE.test(input)) {
    const match = categories.find((c) => c.id === input);
    if (match) return match;
  }

  const lowerInput = input.toLowerCase();
  const nameMatch = categories.find((c) => c.name.toLowerCase() === lowerInput);
  if (nameMatch) return nameMatch;

  const suggestions = suggestClosest(input, categories.map((c) => c.name));
  const suffix = suggestions.length
    ? ` — did you mean: ${suggestions.join(', ')}?`
    : '';
  throw new Error(`Category "${input}" not found${suffix}`);
}

interface Payee {
  id: string;
  name: string;
  transferAcct: string | null;
}

async function fetchPayees(): Promise<Payee[]> {
  const payees = (await actualApi.getPayees()) as Array<{
    id: string;
    name?: string;
    transfer_acct?: string | null;
  }>;
  return payees.map((p) => ({
    id: p.id,
    name: p.name ?? '',
    transferAcct: p.transfer_acct ?? null,
  }));
}

export async function resolvePayee(payeeNameOrId: string): Promise<Payee> {
  const input = payeeNameOrId.trim();
  if (input === '') {
    throw new Error('Payee name cannot be empty');
  }

  const payees = await fetchPayees();

  if (UUID_PREFIX_RE.test(input)) {
    const match = payees.find((p) => p.id === input);
    if (match) return match;
  }

  const lowerInput = input.toLowerCase();
  const nameMatch = payees.find((p) => p.name.toLowerCase() === lowerInput);
  if (nameMatch) return nameMatch;

  const suggestionCandidates = payees
    .filter((p) => p.transferAcct === null)
    .map((p) => p.name);
  const suggestions = suggestClosest(input, suggestionCandidates);
  const suffix = suggestions.length
    ? ` — did you mean: ${suggestions.join(', ')}?`
    : '';
  throw new Error(`Payee "${input}" not found${suffix}`);
}
