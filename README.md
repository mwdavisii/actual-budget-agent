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

## Development

```bash
npm install
npm run build
npm test
npm run dev     # requires .env with secrets
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LLM_PROVIDER` | AI provider: `anthropic` (default), `openai`, or `gemini` |
| `LLM_API_KEY` | API key for the chosen LLM provider |
| `LLM_MODEL` | Model override (defaults: `claude-sonnet-4-6`, `gpt-4o`, `gemini-2.5-flash`) |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_ALLOWED_USER_ID` | Numeric Discord user ID allowed to interact |
| `DISCORD_BUDGET_CHANNEL_ID` | Channel for budget alerts |
| `DISCORD_ERROR_CHANNEL_ID` | Channel for error notifications |
| `ACTUAL_SERVER_URL` | Actual Budget server URL |
| `ACTUAL_PASSWORD` | Actual Budget password |
| `ACTUAL_BUDGET_ID` | Budget sync ID (Settings > Advanced > Sync ID) |
| `SMTP_HOST` | SMTP relay host |
| `SMTP_PORT` | SMTP relay port |
| `EMAIL` | Sender email address |
| `ADDITIONAL_EMAILS` | Comma-delimited recipient(s) for alerts/digests |
| `WEBHOOK_HMAC_KEY` | Shared secret for webhook authentication |
| `DATA_DIR` | Path for SQLite database and Actual sync data |
| `CONFIGMAP_PATH` | Path to settings.json for hot-reload config |

## Dynamic Configuration

The ConfigMap (`/config/settings.json`) supports hot-reload without pod restart:

| Setting | Default | Description |
|---------|---------|-------------|
| `overspendThresholdDollars` | 50 | Minimum overspend amount to trigger email alerts |
| `emailCategories` | `["Natalie's Spending", "Dining Out", "Groceries"]` | Categories that trigger email alerts when overspent |
| `proposalTtlHours` | 24 | Hours before a pending proposal expires and can be re-proposed |
| `payFrequencyDays` | 14 | Days between paychecks (default: biweekly) |
| `lastPayDate` | 2026-03-20 | Known payday anchor date for computing pay schedule |

## Deployment

### Docker

Run with Docker using the pre-built image from GHCR:

```bash
docker run -d \
  --name budget-agent \
  -p 3000:3000 \
  -v budget-agent-data:/data \
  -v $(pwd)/settings.json:/config/settings.json:ro \
  -e LLM_API_KEY=sk-ant-... \
  -e LLM_PROVIDER=anthropic \
  -e DISCORD_TOKEN=... \
  -e DISCORD_ALLOWED_USER_ID=... \
  -e DISCORD_BUDGET_CHANNEL_ID=... \
  -e DISCORD_ERROR_CHANNEL_ID=... \
  -e ACTUAL_SERVER_URL=https://actual.example.com \
  -e ACTUAL_PASSWORD=... \
  -e ACTUAL_BUDGET_ID=... \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_PORT=587 \
  -e EMAIL=budget@example.com \
  -e ADDITIONAL_EMAILS=alice@example.com,bob@example.com \
  -e WEBHOOK_HMAC_KEY=$(openssl rand -hex 32) \
  ghcr.io/mwdavisii/actual-budget-agent:latest
```

Or use an env file:

```bash
docker run -d \
  --name budget-agent \
  -p 3000:3000 \
  -v budget-agent-data:/data \
  -v $(pwd)/settings.json:/config/settings.json:ro \
  --env-file .env \
  ghcr.io/mwdavisii/actual-budget-agent:latest
```

Create a `settings.json` for dynamic configuration (see [Dynamic Configuration](#dynamic-configuration) below):

```json
{
  "overspendThresholdDollars": 50,
  "emailCategories": ["Dining Out", "Groceries"],
  "proposalTtlHours": 24,
  "payFrequencyDays": 14,
  "lastPayDate": "2026-03-20"
}
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
      - ./settings.json:/config/settings.json:ro
    env_file:
      - .env
    restart: unless-stopped

volumes:
  budget-data:
```

### Kubernetes

Deployed via [Flux GitOps](https://fluxcd.io/). Container images are built by GitHub Actions on push to `main` and auto-deployed via Flux image automation. See the [hops](https://github.com/mwdavisii/hops) repo for k8s manifests.

## License

MIT
