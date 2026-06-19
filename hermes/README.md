# Hermes Agent — Budget Agent setup

Connects Hermes Agent to the Actual HTTP Gateway's MCP endpoint so you can
categorize transactions by chatting on Telegram, with Hermes' memory learning
your corrections over time.

This budget agent runs as the dedicated Hermes profile **`pennyworth`** — its own
Hermes home (config, memory, sessions, skills, gateway state), isolated from your
other agents. Target it by prefixing any command with `-p pennyworth`
(`hermes -p pennyworth …`); creating the profile also exposes a `pennyworth …`
alias if you prefer.

## Prerequisites
- The gateway is running and reachable (REST + MCP), with `GATEWAY_TOKEN` set.
- Ollama is running with a tool-calling model (>=64k context, e.g. a Hermes 3 variant).
- The `pennyworth` Hermes profile exists, with its gateway daemon running (required for Telegram + memory): `hermes -p pennyworth gateway start`.

## Steps
1. Copy `config.yaml` and `system-prompt.md` into the `pennyworth` profile's config home and edit the marked values (Ollama URL/model, gateway URL, `GATEWAY_TOKEN`).
2. Register the gateway MCP server on the profile:
   - `hermes -p pennyworth mcp add budget-gateway --transport http --url http://gateway:3000/mcp` (replace `gateway:3000` with your gateway host:port)
   - Provide the gateway bearer token when prompted. If your Hermes version cannot send a static Authorization header to an HTTP MCP server, run the gateway MCP on the trusted homelab network and restrict `/mcp` at the network layer instead.
   - During the probe, enable exactly these 8 tools: `list_uncategorized_transactions`, `query_transactions`, `get_budget_status`, `list_categories`, `get_schedules`, `get_targets`, `get_underfunded`, `apply_category`.
3. Pair your Telegram account to the `pennyworth` profile (see Hermes messaging docs) and confirm unknown DMs are ignored.
4. Smoke test: DM the bot "categorize my latest transactions", confirm categories land in Actual, then correct one and confirm it re-applies and is remembered.

## Step 2 (later cycle): n8n trigger
A deterministic n8n workflow will POST to a Hermes webhook route to trigger
categorization automatically after bank sync. Not part of this setup.
