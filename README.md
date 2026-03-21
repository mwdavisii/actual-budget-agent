# Budget Agent

An AI-powered assistant for [Actual Budget](https://actualbudget.org/) that monitors spending, generates alerts, and provides budget insights via Discord and email.

## How It Works

Budget Agent connects to your Actual Budget server and responds to scheduled webhook triggers. Each trigger runs a specific check (overspent categories, uncategorized transactions, etc.), and the agent uses an LLM (Claude, GPT, or Gemini) to analyze the results and post actionable proposals to a Discord channel. Critical alerts are also emailed.

### Alert Types

| Trigger | Schedule | Description |
|---------|----------|-------------|
| **Bank Sync** | Daily 6am | Syncs all on-budget accounts via SimpleFIN, then runs uncategorized categorization |
| **Uncategorized** | Runs as part of bank sync | Transactions missing a category — agent proposes categories via Discord approval cards |
| **Overspent** | Daily 8am | Categories where spending exceeds the budget |
| **Unfunded** | Daily 8am | Scheduled bills with no budget allocated |
| **Seed Targets** | 1st of month 7am | Captures current budgeted amounts as target baseline |
| **Pay-Period Allocation** | Daily 6:30am | On paydays, allocates budget from targets (fixed bills + discretionary split) |
| **Monthly Review** | 1st of month | End-of-month budget summary |
| **Weekly Digest** | Monday 7am | Weekly spending summary email |

### Architecture

```
CronJobs (HMAC-signed webhooks)
        |
        v
  Express Server --> Webhook Handlers
        |                   |
        v                   v
  Discord Bot        Actual Budget API
        |                   |
        v                   v
  LLM Agent   <---- Budget Data
        |
        v
  Discord Thread + Email Alerts
```

- **Webhook server** — Express with HMAC-SHA256 authentication
- **AI agent** — Configurable LLM (Claude, GPT, or Gemini) with tools for querying budget data and proposing changes
- **Proposal cards** — Discord messages with Approve/Reject/Skip buttons showing payee, amount, account, and category
- **Deduplication** — Proposals are cached by transaction ID for a configurable TTL (default 24h), preventing duplicate proposals across webhook runs
- **Write operations** — The agent now writes budget amounts back to Actual via `setBudgetAmount` (first write operation), enabling pay-period allocation and target adjustments
- **Discord** — Alerts posted to threads in a designated channel
- **Email** — Overspend alerts and weekly digests via SMTP relay
- **Storage** — SQLite for conversation sessions and budget change proposals

## Budget Targets

Budget targets provide a monthly allocation baseline the agent can reason about and act on:

- **Auto-seeded** on the 1st of each month from current budgeted amounts
- **User adjusts** budgeted amounts in Actual to match available funds throughout the month
- **"What's underfunded?"** — agent compares targets to current budgets and surfaces gaps
- **Pay-period allocation** — on paydays, the agent sets budget amounts from targets: fixed bills get their full target when due, discretionary categories are split across two paychecks
- **3rd paycheck months** — the 3rd paycheck is intentionally left unallocated for manual use (e.g., emergency fund, irregular expenses)

## Agent Tools

In addition to scheduled webhooks, the agent exposes conversational tools for Discord interactions:

| Tool | Description |
|------|-------------|
| `getBudgetTargets` | Retrieve stored monthly targets for all categories |
| `setBudgetTarget` | Update the target amount for a specific category |
| `seedBudgetTargets` | Snapshot current budgeted amounts as the new target baseline |
| `getUnderfundedCategories` | List categories where current budget is below target |
| `allocatePayPeriodBudget` | Allocate budget from targets for the current pay period |

## Prerequisites

### Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**
2. Under **Bot**, click **Reset Token** and save the token — this is your `DISCORD_TOKEN`
3. Enable these **Privileged Gateway Intents**: Message Content, Server Members (optional)
4. Under **OAuth2 > URL Generator**, select scopes `bot` and permissions: Send Messages, Send Messages in Threads, Create Public Threads, Manage Messages, Read Message History, Use External Emojis
5. Open the generated URL to invite the bot to your server
6. In Discord, enable Developer Mode (User Settings > Advanced), then right-click to copy IDs:
   - Your user ID → `DISCORD_ALLOWED_USER_ID`
   - Budget alerts channel → `DISCORD_BUDGET_CHANNEL_ID`
   - Error notifications channel → `DISCORD_ERROR_CHANNEL_ID`

### Actual Budget

You need a running [Actual Budget](https://actualbudget.org/) server (self-hosted). From the app:

1. Go to **Settings > Advanced** and copy the **Sync ID** — this is your `ACTUAL_BUDGET_ID`
2. Your server URL (e.g. `https://actual.example.com`) → `ACTUAL_SERVER_URL`
3. Your server password → `ACTUAL_PASSWORD`

For bank sync to work, connect your accounts to [SimpleFIN](https://simplefin.org/) through Actual's linked accounts feature.

### LLM API Key

Get an API key from your chosen provider:

- **Anthropic** (default): [console.anthropic.com](https://console.anthropic.com/) → `LLM_API_KEY`
- **OpenAI**: [platform.openai.com](https://platform.openai.com/) → set `LLM_PROVIDER=openai`
- **Google Gemini**: [aistudio.google.com](https://aistudio.google.com/) → set `LLM_PROVIDER=gemini`

## Development

```bash
npm install
npm run build
npm test
npm run dev     # requires .env with secrets
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LLM_API_KEY` | API key for the chosen LLM provider |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_ALLOWED_USER_ID` | Numeric Discord user ID allowed to interact |
| `DISCORD_BUDGET_CHANNEL_ID` | Channel for budget alerts |
| `DISCORD_ERROR_CHANNEL_ID` | Channel for error notifications |
| `ACTUAL_SERVER_URL` | Actual Budget server URL |
| `ACTUAL_PASSWORD` | Actual Budget password |
| `ACTUAL_BUDGET_ID` | Budget sync ID (Settings > Advanced > Sync ID) |
| `WEBHOOK_HMAC_KEY` | Shared secret for webhook authentication |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `anthropic` | AI provider: `anthropic`, `openai`, or `gemini` |
| `LLM_MODEL` | per-provider | Model override (defaults: `claude-sonnet-4-6`, `gpt-4o`, `gemini-2.5-flash`) |
| `ENABLE_EMAIL` | `false` | Set to `true` to enable email alerts (requires SMTP vars below) |
| `SMTP_HOST` | | SMTP relay host (required if email enabled) |
| `SMTP_PORT` | | SMTP relay port (required if email enabled) |
| `EMAIL` | | Sender email address (required if email enabled) |
| `ADDITIONAL_EMAILS` | | Comma-delimited recipient(s) for alerts/digests (required if email enabled) |
| `DATA_DIR` | `/data` | Path for SQLite database and Actual sync data |
| `CONFIGMAP_PATH` | | Path to settings.json for hot-reload config (Kubernetes) |

## Budget Configuration

These env vars control agent behavior. All are optional with sensible defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `OVERSPEND_THRESHOLD_DOLLARS` | `50` | Minimum overspend amount (dollars) to trigger email alerts |
| `EMAIL_CATEGORIES` | `Dining Out,Groceries` | Comma-delimited budget category names that trigger email alerts when overspent |
| `PROPOSAL_TTL_HOURS` | `24` | Hours before a pending proposal expires and can be re-proposed |
| `PAY_FREQUENCY_DAYS` | `14` | Days between paychecks (e.g. 14 for biweekly, 7 for weekly) |
| `LAST_PAY_DATE` | `2025-01-03` | A known past payday (any Friday works). Used as an anchor to compute your pay schedule — the agent counts forward by `PAY_FREQUENCY_DAYS` to determine future paydays. |

**Optional file override:** If `CONFIGMAP_PATH` is set to a JSON file path, values in that file take precedence over env vars. This supports hot-reload for Kubernetes ConfigMaps without pod restart.

## Deployment

### Docker

Run with Docker using the pre-built image from GHCR:

```bash
docker run -d \
  --name budget-agent \
  -p 3000:3000 \
  -v budget-agent-data:/data \
  -e LLM_API_KEY=sk-ant-... \
  -e DISCORD_TOKEN=... \
  -e DISCORD_ALLOWED_USER_ID=... \
  -e DISCORD_BUDGET_CHANNEL_ID=... \
  -e DISCORD_ERROR_CHANNEL_ID=... \
  -e ACTUAL_SERVER_URL=https://actual.example.com \
  -e ACTUAL_PASSWORD=... \
  -e ACTUAL_BUDGET_ID=... \
  -e WEBHOOK_HMAC_KEY=$(openssl rand -hex 32) \
  ghcr.io/mwdavisii/actual-budget-agent:latest
```

To enable email alerts, add:

```bash
  -e ENABLE_EMAIL=true \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_PORT=587 \
  -e EMAIL=budget@example.com \
  -e ADDITIONAL_EMAILS=alice@example.com,bob@example.com \
```

Or use an env file:

```bash
docker run -d \
  --name budget-agent \
  -p 3000:3000 \
  -v budget-agent-data:/data \
  --env-file .env \
  ghcr.io/mwdavisii/actual-budget-agent:latest
```

#### Triggering Webhooks with Cron

The agent responds to HMAC-signed webhook POSTs. Without Kubernetes CronJobs, use the host crontab or a sidecar container. Example crontab entry for bank sync at 6am daily:

```bash
# Generate the HMAC signature and POST to the webhook
0 6 * * * BODY='{"checkType":"bank_sync","triggeredAt":"'$(date -u +\%Y-\%m-\%dT\%H:\%M:\%SZ)'"}' && SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_HMAC_KEY" | sed 's/^.* //')" && curl -sf -X POST -H "Content-Type: application/json" -H "X-Webhook-Signature: $SIG" -d "$BODY" http://localhost:3000/webhook
```

Available `checkType` values: `bank_sync`, `allocate_pay_period`, `seed_targets`, `overspent_categories`, `unfunded_bills`, `monthly_review`, `weekly_digest`.

### Docker Compose

```yaml
services:
  budget-agent:
    image: ghcr.io/mwdavisii/actual-budget-agent:latest
    ports:
      - "3000:3000"
    volumes:
      - budget-data:/data
    env_file:
      - .env
    restart: unless-stopped

volumes:
  budget-data:
```

### Kubernetes

Deployed via [Flux GitOps](https://fluxcd.io/). Container images are built by GitHub Actions on push to `main` and auto-deployed via Flux image automation. See the [hops](https://github.com/mwdavisii/hops) repo for k8s manifests.

## License

ISC
