# Budget Agent — HTTP Gateway

Budget Agent is an HTTP gateway over [Actual Budget](https://actualbudget.org/). It owns the single persistent connection to Actual and exposes a REST API consumed by n8n automations and an MCP layer (sub-project B of a larger n8n + Hermes migration — spec in docs). Running as the sole Actual connection prevents concurrent-access corruption while allowing multiple upstream callers.

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `ACTUAL_SERVER_URL` | Actual Budget server URL (e.g. `https://actual.example.com`) |
| `ACTUAL_PASSWORD` | Actual Budget server password |
| `ACTUAL_BUDGET_ID` | Budget sync ID (Actual Settings > Advanced > Sync ID) |
| `GATEWAY_TOKEN` | Shared bearer token for API authentication |

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
| `POST` | `/tx/query` | Query transactions with filters |
| `POST` | `/tx/:id/category` | Set the category on a transaction |
| `GET` | `/budget/status` | Current month budget status |
| `GET` | `/schedules` | Upcoming scheduled transactions |
| `GET` | `/categories` | All budget category groups and categories |
| `POST` | `/accounts/sync` | Trigger a bank sync across all linked accounts |
| `GET` | `/targets` | Retrieve stored monthly targets |
| `POST` | `/targets/seed` | Snapshot current budgeted amounts as target baseline |
| `GET` | `/targets/underfunded` | Categories where current budget is below target |
| `GET` | `/targets/export` | Export all targets as JSON |
| `POST` | `/targets/import` | Import targets from a JSON payload (upserts) |

## Development

```bash
npm install
npm run build
npm test
npm run dev   # requires .env with the required vars above
```

## License

ISC
