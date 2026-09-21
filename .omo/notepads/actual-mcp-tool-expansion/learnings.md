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

## 2026-09-21 — Wave 2: `src/actual/queries.ts` transaction extensions

- **Default `getTransactions` output is frozen at 10 keys:** `id`, `date`, `amount`, `payee`, `payeeName`, `category`, `notes`, `account`, `accountName`, `cleared`. `categoryName` and the other new `Transaction` optional fields are only emitted when the caller requests them via `fields` (or `select('*')` for `getTransactionById`).
- **Lazy category map:** `getTransactions` only calls `getCategoryGroups()` when `summary: 'category'` or `fields` includes `categoryName`; this avoids forcing `getCategoryGroups` into every existing unit-test mock.
- **Summary mode uses three queries:** a scalar `calculate({ $sum: '$amount' })` for `totalMatching`, a `groupBy` + `$count` query for per-group counts, and a detail query for `date`/`amount` to compute `firstDate`, `lastDate`, and `totalAmount` client-side.
- **Actual LIKE wildcards:** only `%` and `?` are wildcards; `_` is literal. `notesContains` escapes `[\\%?]` with a backslash before wrapping in `%...%`.
- **`getTransactionById`** fetches with `filter({ id }).select('*').options({ splits: 'grouped' })` and enriches `payeeName`, `accountName`, and `categoryName`.
- **`getPayeesWithCounts`** runs a grouped `transactions` query over all payee ids and returns each payee with `txCount` plus an `isTransfer` flag derived from `transfer_acct != null`.

## 2026-09-21 — Wave 2: `src/actual/rules.ts`

- **Native rule entity vs input shape diverge:** `getRules()` returns `RuleEntity` whose `actions` have `op: string` (they can be `set-split-amount`, `link-schedule`, `delete-transaction`, etc.), while the gateway's `RuleInput` narrows `op` to `'set' | 'prepend-notes' | 'append-notes'`. The evaluator must type its action loop against the broad `{ op: string; field?: string; value: unknown }` shape, not the narrow input type, or `tsc` rejects the `applyRule` call.
- **`resolveCategory`/`resolvePayee` only recognize UUID-prefixed ids:** a short id like `c1` is treated as a *name* and rejected. Rule action values in tests must use real names (or full UUIDs), not short ids — the realistic agent scenario is a name anyway.
- **`matches` is not evaluator-supported on id fields:** `account`/`payee`/`category` are `id`-typed; the evaluator's `matches` op only makes sense on string fields. Validation rejects `matches` on id fields so validation and evaluation stay aligned (the plan's "rejected here too" note).
- **`date` has no `isbetween`:** `TYPE_INFO.date.ops` is `is,isapprox,gt,gte,lt,lte` — `isbetween` is number-only. Validation rejects it for `date`; `isapprox` on date is accepted for CRUD but the evaluator treats it as a numeric comparison (semantics unverified, per plan).
- **`isapprox` threshold is ±7.5%:** `getApproxNumberThreshold` rounds `Math.abs(value) * 0.075`; the evaluator mirrors this with `Math.abs(actual - expected) <= Math.round(Math.abs(expected) * 0.075)`.
- **Stage ordering:** `rankRules` is `pre.concat(normal).concat(post)` with ascending id within each stage (mirrors native `rankRules` at dist/index.js:108156-108173). The evaluator re-implements this locally.
- **`contains` semantics:** native `contains` compiles to `$like %value%` (case-insensitive via `likePatternToRegex`); the evaluator mirrors with a lowercase `includes`.
- **No `./queries` import:** `rules.ts` fetches rows via `actualApi.runQuery(actualApi.q('transactions')...)` directly, keeping it independent of todo 2 (queries.ts) so it compiles in Wave 2. `grep` confirms zero `queries` references in the file.
- **SIZE_OK exception:** `rules.ts` is ~440 pure LOC — over the 250 ceiling — but the plan mandates a single file (todo 7 imports all six exports from `src/actual/rules.ts`), and the module is one indivisible responsibility (the rules engine: types + validation + humanize + CRUD + evaluator). Splitting would break the plan's dependency contract.

## 2026-09-21 — Wave 3: `src/actual/analysis.ts`

- **`getAccounts()` from `queries.ts` is the validation gate:** `getUnreconciled` resolves and validates the account through `getAccounts()` so the error message uses human-readable account names and the same suggestion ranking as naming helpers.
- **`last_reconciled` lives only on the raw account entity:** `getAccounts()` enriches balances but drops `last_reconciled`; fetch it from a second `actualApi.getAccounts()` call (or an AQL accounts query) after validation.
- **Scalar `calculate` returns `{ data: scalar }`:** `actualApi.runQuery(query.calculate({ $sum: '$amount' }))` resolves to a scalar in `.data`, not an array. Read it as `Number(result.data ?? 0)`.
- **Running balance is client-side:** AQL `orderBy` only reliably supports a single field in this codebase, so sort uncleared rows by `date` then `id` in memory and accumulate `runningBalance`.
- **Duplicate-payee normalization:** lowercase, strip digits and non-letters (keep spaces), collapse whitespace. "Starbucks #123" and "Starbucks-456!" both normalize to "starbucks".
- **Transfer payees must be excluded before grouping:** any payee with `transfer_acct != null` is a transfer target and must not appear in merge/suggestion lists.
- **Per-payee stats via grouped AQL:** `q('transactions').filter({ payee: { $oneof: ids } }).groupBy('payee').select(['payee', { count: { $count: '$id' }, minDate: { $min: '$date' }, maxDate: { $max: '$date' } }])` gives count + date range in one query.
- **Canonical duplicate = highest count:** within a normalized group, sort by count descending then name ascending; the first member is the suggested canonical, remaining members are duplicates.

## 2026-09-21 — Wave 3: `src/actual/mutations.ts`

- **`updateTransaction` return value is unreliable for read-back:** the native method returns an array that is often empty, so every mutation helper re-fetches the row via `getTransactionById` to return enriched post-state (`categoryName`, `payeeName`, `transferId`).
- **`batchBudgetUpdates` only batches sync messages:** individual `updateTransaction` calls inside the callback remain separate DB operations, so `applyCategoryBulk` is genuinely non-atomic — per-row `try/catch` is required, and earlier rows stay applied when a later row fails.
- **`mergePayees` silently skips transfer payees in Actual:** the gateway must pre-reject transfer payees as both target and source because the underlying API would silently ignore them, leaving the caller with a misleading success.
- **Bulk error entries use `String(err)`:** this produces `"Error: <message>"` for thrown Error objects, which is the standard shape for per-id bulk error entries.
- **Dry-run bulk category writes perform zero mutations:** only `getTransactionById` reads are issued to build the before/after projection; `updateTransaction` and `batchBudgetUpdates` are never called.
- **`WriteResult` type mirrors `getTransactionById` enrichment:** `NonNullable<Awaited<ReturnType<typeof getTransactionById>>>` captures the full enriched `Transaction` shape without duplicating the interface.

## 2026-09-21 — Wave 4: `src/mcp/tools/shared.ts` + `src/mcp/tools/writes.ts`

- **`shared.ts` breaks the future circular import:** `jsonContent`/`errorContent` live in their own module so `writes.ts`, `rules.ts`, and `analysis.ts` can import them without importing from `src/mcp/tools.ts`, where the aggregator in todo 9 will wire the modules together.
- **Per-module MCP tests build a fresh `McpServer`:** `tools.writes.test.ts` constructs `new McpServer(...)` and calls `registerWriteTools` directly, mirroring the `InMemoryTransport` + `textOf` harness from `tools.test.ts` but isolating the module under test.
- **Dry-run defaults differ by risk:** `merge_payees` schema defaults `dryRun: true` (deletes source payees); `apply_category_bulk` defaults `dryRun: false` (cheap, idempotent, reversible on an explicit id list).
- **Error mapping is a single seam:** messages matching `/not found/i` (category/payee/transaction not found, including the embedded `did you mean` suggestions) are returned verbatim via `errorContent`; all other failures are wrapped as `Actual Budget write failed: ${msg}`.
- **`update_transaction` fields stay non-strict:** the `fields` object intentionally omits `.strict()` so unknown keys reach `updateTransactionFields` and its `Updating X is not supported` directive surfaces to the caller.

## 2026-09-21 — Wave 5: `src/mcp/tools/analysis.ts`

- **Read tools mirror write-tool structure:** `registerAnalysisTools` uses the same `McpServer` + `InMemoryTransport` harness as `writes.ts`/`rules.ts`, but mocks only `withActualRead` (no write wrapper) and the analysis data modules.
- **Null read = explicit not-found error:** `getTransactionById` returns `null` for an unknown id; the tool handler converts that to `errorContent(\`Transaction ${txId} not found\`)` rather than letting it fall through to the generic read-failed wrapper.
- **Read error mapping is symmetric with writes:** `/not found/i` messages pass through verbatim (account-not-found suggestions from `getUnreconciled` reach the caller); everything else becomes `Actual Budget read failed: ${msg}`.
- **No-arg tool pattern:** `find_duplicate_payees` uses `inputSchema: {}` and an argument-less handler, matching `list_uncategorized_transactions` and `list_payees`.
