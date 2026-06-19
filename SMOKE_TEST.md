# Gateway Manual Smoke Test

Requires a reachable Actual server and a valid budget. Build, then start the gateway:

    npm run build
    DATA_DIR=/tmp/gw GATEWAY_TOKEN=secret \
      ACTUAL_SERVER_URL=https://actual.example \
      ACTUAL_PASSWORD=... ACTUAL_BUDGET_ID=... \
      node dist/index.js

In another shell (export `T=secret` to match `GATEWAY_TOKEN`):

- [ ] `curl -s localhost:3000/healthz` → `{"status":"ok"}`
- [ ] `curl -s localhost:3000/readyz` → `{"status":"ready"}`
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/tx/uncategorized` → `401` (no token)
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/categories` → JSON category groups
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/budget/status` → category status list
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/schedules` → upcoming scheduled transactions
- [ ] `curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
        -d '{"amountMin":-100000}' localhost:3000/tx/query` → matching transactions
- [ ] `curl -s -X POST -H "Authorization: Bearer $T" localhost:3000/targets/seed` → `{"success":true,"count":N}`
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/targets` → seeded targets with `gap`
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/targets/underfunded` → categories below target
- [ ] `curl -s -H "Authorization: Bearer $T" localhost:3000/targets/export` → `{"exportedAt":...,"targets":[...]}`
- [ ] Apply a category to a real uncategorized transaction and confirm it appears in the Actual web UI:
      `curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
        -d '{"category":"Groceries"}' localhost:3000/tx/<TXID>/category` → `{"success":true,...}`
- [ ] `curl -s -X POST -H "Authorization: Bearer $T" localhost:3000/accounts/sync` → `{"synced":[...],"failed":[...]}`
- [ ] Two reads within ~45s (`SYNC_TTL_SECONDS`) should NOT each log a fresh `"Actual Budget synced"` — the second is served from the warm cache.

## Error-path spot checks

- [ ] Bad token → `401`: `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" localhost:3000/categories`
- [ ] Malformed month → `400`: `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" "localhost:3000/budget/status?month=2026-1"`
- [ ] Unknown category on apply → `404` with `{"error":"...not found"}`.
- [ ] Stop the Actual server, then hit any data route → `502 {"error":"actual unreachable: ..."}`.

## MCP endpoint (for Hermes)

With the gateway running (`T=secret`):

- [ ] `curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'` → `401` (no token)
- [ ] Same call with `-H "Authorization: Bearer $T" -H 'Accept: application/json, text/event-stream'` → `200`, body mentions `budget-gateway`.

## Hermes end-to-end

- [ ] `hermes -p pennyworth mcp` probe against the gateway lists the 8 budget tools.
- [ ] Telegram: "categorize my latest transactions" → categories applied (verify in Actual web UI) + a summary in chat.
- [ ] Telegram correction ("that one is Household, not Groceries") → re-applied in Actual; ask again later and the same payee is categorized the corrected way (memory recall).
