# n8n workflows — Budget Categorize

The scheduled automation that runs the budget agent end to end: sync accounts,
find uncategorized transactions, gather context, and hand them to the
`pennyworth` Hermes profile to categorize via the gateway's MCP endpoint.

## Source of truth

These two JSON files are **bootstrap templates only** — so a fresh n8n can be
brought up by import. Once a workflow is running, **n8n itself is the source of
truth** (including its version history). Don't hand-edit these files to change a
live workflow; use the n8n UI or the n8n-mcp tools
(`n8n_update_partial_workflow`, etc.). Re-export on demand with
`n8n_get_workflow` if you want to refresh the templates.

| File | Workflow | Role |
|---|---|---|
| `budget-categorize.json` | **Budget Categorize** | Daily trigger + context builder (9 nodes) |
| `consult-pennyworth.json` | **Consult Pennyworth** | Reusable delivery sub-workflow: SSH → `hermes -p pennyworth` → Telegram (2 nodes) |

## Flow

```
Schedule Trigger (daily 08:00)
  → Sync Accounts            POST {GATEWAY_URL}/accounts/sync   (Continue on Fail)
  → Get Uncategorized        GET  {GATEWAY_URL}/tx/uncategorized
  → No Transactions (IF)     length == 0 ? stop (silent) : continue
  → [ Get Categories ‖ Get Budget Status ]   (both executeOnce — see note)
  → Merge Context
  → Build Prompt             Code: emits bishop_instruction + bishop_payload
  → Call 'Consult Pennyworth'  Execute Sub-workflow

Consult Pennyworth:
  Input (bishop_instruction, bishop_payload)
  → Deliver via Pennyworth   SSH: hermes chat -Q -p pennyworth -q "<instruction + payload>"
                                  | hermes send --to telegram:$PENNYWORTH_TELEGRAM_CHAT_ID --quiet
```

**Why `executeOnce` on the two GET nodes:** the IF node forwards one item per
uncategorized transaction. Without `executeOnce`, those HTTP nodes would fire
once per transaction (N× fan-out). `executeOnce` makes each run a single time;
`Build Prompt` then re-aggregates everything with `$('node').all()`.

**Why a sub-workflow for delivery:** mirrors the proven `Consult Cato` pattern.
Keeping the SSH/Hermes/Telegram step in one reusable workflow isolates the
shell-escaping (`.replace(/[`$]/g, '\\$&')`) and the `hermes` invocation that
the rest of the homelab already relies on.

## Required n8n environment variables

Settings → Environment (restart n8n after changing):

| Variable | Value |
|---|---|
| `GATEWAY_URL` | Base URL of the Actual HTTP Gateway, e.g. `https://budget-agent.mwdavisii.com` (no trailing slash) |
| `PENNYWORTH_TELEGRAM_CHAT_ID` | Telegram chat id the pennyworth bot replies to |

## Required credentials

| Credential | Type | Used by |
|---|---|---|
| `Budget Gateway` | HTTP Header Auth — header `Authorization`, value `Bearer <GATEWAY_TOKEN>` | the 4 HTTP nodes in Budget Categorize |
| `SSH Password account` | SSH (password) — the Mac running Hermes | `Deliver via Pennyworth` |

`GATEWAY_TOKEN` must equal the gateway's `GATEWAY_TOKEN`. The token lives only in
the credential (and, for Hermes' own MCP client, in the pennyworth profile's
`.env` as `BUDGET_MCP_TOKEN`) — never inline in a workflow.

## Importing into a fresh n8n

1. **Import from File** → `consult-pennyworth.json`, then `budget-categorize.json`.
2. Set the env vars above.
3. Create the two credentials and select them on the nodes (the JSON uses
   `REPLACE_*` placeholders for credential / workflow / error-workflow ids).
4. On `Call 'Consult Pennyworth'`, point the Workflow selector at the imported
   Consult Pennyworth (replaces `REPLACE_CONSULT_PENNYWORTH_WORKFLOW_ID`).
5. Set each workflow's Error Workflow (replaces `REPLACE_ERROR_WORKFLOW_ID`).
6. **Activate** Budget Categorize. The schedule (08:00 daily) is in
   `America/Chicago` per n8n's instance timezone — adjust the Schedule Trigger
   if needed.

## Deploying directly (optional)

If n8n-mcp is configured with `N8N_API_URL` + `N8N_API_KEY`, these can be
created/updated programmatically instead of imported by hand.
