# Budget Agent

An AI-powered assistant for [Actual Budget](https://actualbudget.org/) that monitors spending, generates alerts, and provides budget insights via Discord and email.

## How It Works

Budget Agent connects to your Actual Budget server and responds to scheduled webhook triggers. Each trigger runs a specific check (overspent categories, uncategorized transactions, etc.), and the agent uses Claude Sonnet to analyze the results and post actionable proposals to a Discord channel. Critical alerts are also emailed.

### Alert Types

| Trigger | Schedule | Description |
|---------|----------|-------------|
| **Uncategorized** | Every 6 hours | Transactions missing a category — agent proposes categories via Discord approval cards |
| **Overspent** | Daily 8am | Categories where spending exceeds the budget |
| **Unfunded** | Daily 8am | Scheduled bills with no budget allocated |
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
  Claude Agent <---- Budget Data
        |
        v
  Discord Thread + Email Alerts
```

- **Webhook server** — Express with HMAC-SHA256 authentication
- **AI agent** — Claude Sonnet with tools for querying budget data and proposing changes
- **Proposal cards** — Discord messages with Approve/Reject/Skip buttons showing payee, amount, account, and category
- **Deduplication** — Proposals are cached by transaction ID for a configurable TTL (default 24h), preventing duplicate proposals across webhook runs
- **Discord** — Alerts posted to threads in a designated channel
- **Email** — Overspend alerts and weekly digests via SMTP relay
- **Storage** — SQLite for conversation sessions and budget change proposals

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
| `CLAUDE_API_KEY` | Anthropic API key |
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
| `WIFE_EMAIL` | Recipient for alerts/digests |
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

## Deployment

Deployed to Kubernetes via [Flux GitOps](https://fluxcd.io/). Container images are built by GitHub Actions on push to `main` and auto-deployed via Flux image automation. See the [hops](https://github.com/mwdavisii/hops) repo for k8s manifests.

## License

MIT
