# Budget Agent — HTTP Gateway

Budget Agent is an HTTP gateway over [Actual Budget](https://actualbudget.org/). It owns the single persistent connection to Actual and exposes a REST API consumed by n8n automations and an MCP layer (sub-project A of a larger n8n + Hermes migration — spec in docs). Running as the sole Actual connection prevents concurrent-access corruption while allowing multiple upstream callers.

> **Migrating from the legacy Discord/LLM agent?** This gateway is headless — it has no Discord bot, LLM agent, email, or scheduled webhooks (those move to n8n/Hermes in later sub-projects). The only new required variable is `GATEWAY_TOKEN`; `ACTUAL_*` carry over. The old `DISCORD_*`, `WEBHOOK_HMAC_KEY`, `LLM_API_KEY`, `SMTP_*`, `EMAIL`, and `ADDITIONAL_EMAILS` variables are now ignored and can be removed.

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `ACTUAL_SERVER_URL` | Actual Budget server URL (e.g. `https://actual.example.com`) |
| `ACTUAL_PASSWORD` | Actual Budget server password |
| `ACTUAL_BUDGET_ID` | Budget sync ID (Actual Settings > Advanced > Sync ID) |
| `GATEWAY_TOKEN` | Shared bearer token for API authentication. Generate one yourself, e.g. `openssl rand -hex 32`, and give the same value to every caller. |

## Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `/data` | Path for SQLite database and Actual sync data |
| `PORT` | `3000` | HTTP port to listen on |
| `SYNC_TTL_SECONDS` | `45` | Seconds before the local Actual cache is considered stale and re-downloaded |

## Routes

All routes except the health probes require `Authorization: Bearer <GATEWAY_TOKEN>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Liveness probe — always 200 |
| `GET` | `/readyz` | Readiness probe — 200 once the HTTP server is listening (the Actual connection warms lazily on the first data request) |
| `GET` | `/tx/uncategorized` | List uncategorized transactions |
| `POST` | `/tx/query` | Query transactions with filters (`startDate`, `endDate`, `accountId`, `categoryId`, `amountMin`, `amountMax`, `cleared`, `payeeId`, `payeeContains`, `notesContains`, `limit`, `offset`, `orderBy`, `fields`, `summary`) |
| `POST` | `/tx/:id/category` | Set the category on a transaction |
| `GET` | `/budget/status` | Current month budget status |
| `GET` | `/schedules` | Upcoming scheduled transactions |
| `GET` | `/categories` | All budget category groups and categories |
| `POST` | `/accounts/sync` | Trigger a bank sync across all linked accounts |
| `GET` | `/accounts` | List accounts with balances (cents) |
| `GET` | `/targets` | Retrieve stored monthly targets |
| `POST` | `/targets/seed` | Snapshot current budgeted amounts as target baseline |
| `GET` | `/targets/underfunded` | Categories where current budget is below target |
| `GET` | `/targets/export` | Export all targets as JSON |
| `POST` | `/targets/import` | Import targets from a JSON payload (upserts) |

## MCP tools

The gateway exposes an MCP server at `/mcp` with 23 tools:

- `list_uncategorized_transactions`, `query_transactions`, `get_budget_status`, `list_categories`, `get_accounts`, `get_schedules`, `get_targets`, `get_underfunded`, `apply_category`
- `apply_category_bulk`, `set_payee`, `list_payees`, `merge_payees`, `get_transaction`, `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `explain_transaction`, `run_rules`, `get_unreconciled`, `find_duplicate_payees`, `update_transaction`

## Example request

```bash
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://localhost:3000/budget/status
```

Missing/invalid token → `401`. Bad parameters → `400`. Unknown transaction/category → `404`. Actual unreachable → `502`. All errors are JSON: `{ "error": "..." }`.

## Deployment

The container is built and published to GHCR on push to `main` (see `.github/workflows/build-container.yml`). It runs `node dist/index.js` and listens on `PORT` (default `3000`). Provide the required environment variables and mount a volume at `DATA_DIR` to persist the SQLite store (targets) and the Actual sync cache. See `SMOKE_TEST.md` for a post-deploy verification checklist.

## Development

```bash
npm install
npm run build
npm test
npm run dev   # requires .env with the required vars above
```

## License

ISC
