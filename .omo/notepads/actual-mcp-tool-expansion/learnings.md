# Learnings — actual-mcp-tool-expansion

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-09-21 — Wave 1: `src/actual/naming.ts`

- **Per-file mock pattern:** every unit test under `tests/unit/actual` mocks `../../../src/actual/client` directly with the subset of `actualApi` methods it calls (see `queries.payees.test.ts`). This keeps tests isolated and avoids leaking mock state between modules.
- **UUID resolution now validates existence:** `resolveCategory` and `resolvePayee` treat an 8-hex-digit UUID prefix as a candidate ID but still call `getCategoryGroups()` / `getPayees()` to confirm the id exists. Tests that previously passed UUIDs straight through must now mock the lookup list.
- **Error prefix contract:** consumers in `src/http/routes/transactions.ts` and `src/mcp/tools.ts` match `/category .* not found/i`, so the unknown-category error must keep the literal prefix `Category "X" not found`.
- **Transfer payees:** `getPayees()` returns `transfer_acct` as an optional field; any payee with `transfer_acct != null` is a transfer payee and must be excluded from suggestion lists and merge targets.
- **API shape leniency:** `getCategoryGroups()` returns groups whose `categories` array is optional in the published types, so resolution helpers should fall back to an empty array (`g.categories ?? []`).
- **Suggestion ranking:** substring match (candidate contains input) > prefix match (candidate starts with input) > Levenshtein distance, all computed on lowercase strings; exact case-insensitive matches are excluded from suggestions.
