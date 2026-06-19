# Hermes Agent — Budget Agent setup

Connects Hermes Agent to the Actual HTTP Gateway's MCP endpoint so you can
categorize transactions by chatting on Telegram, with Hermes' memory learning
your corrections over time.

## Prerequisites
- The gateway is running and reachable (REST + MCP), with `GATEWAY_TOKEN` set.
- Ollama is running with a tool-calling model (>=64k context, e.g. a Hermes 3 variant).
- Hermes Agent installed, with its gateway daemon running (required for Telegram + memory).

## Steps
1. Copy `config.yaml` and `system-prompt.md` into your Hermes config location and edit the marked values (Ollama URL/model, gateway URL, `GATEWAY_TOKEN`).
2. Register the gateway MCP server:
   - `hermes mcp add budget-gateway --transport http --url http://<gateway-host>:3000/mcp`
   - Provide the gateway bearer token when prompted. If your Hermes version cannot send a static Authorization header to an HTTP MCP server, run the gateway MCP on the trusted homelab network and restrict `/mcp` at the network layer instead.
   - During the probe, enable exactly these 8 tools: `list_uncategorized_transactions`, `query_transactions`, `get_budget_status`, `list_categories`, `get_schedules`, `get_targets`, `get_underfunded`, `apply_category`.
3. Pair your Telegram account (see Hermes messaging docs) and confirm unknown DMs are ignored.
4. Smoke test: DM the bot "categorize my latest transactions", confirm categories land in Actual, then correct one and confirm it re-applies and is remembered.

## Step 2 (later cycle): n8n trigger
A deterministic n8n workflow will POST to a Hermes webhook route to trigger
categorization automatically after bank sync. Not part of this setup.
