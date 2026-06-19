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
