# Budget Agent

An AI-powered assistant for [Actual Budget](https://actualbudget.org/) that monitors spending, generates alerts, and provides budget insights via Discord and email.

## How It Works

Budget Agent connects to your Actual Budget server and responds to scheduled webhook triggers. Each trigger runs a specific check (overspent categories, uncategorized transactions, etc.), and the agent uses Claude to analyze the results and post summaries to a Discord channel. Critical alerts are also emailed.

### Alert Types

| Trigger | Description |
|---------|-------------|
| **Overspent** | Categories where spending exceeds the budget |
| **Uncategorized** | Transactions missing a category |
| **Unfunded** | Categories with no budget allocated |
| **Monthly Review** | End-of-month budget summary |
| **Weekly Digest** | Weekly spending summary email |

### Architecture

```
CronJobs (HMAC-signed webhooks)
        │
        ▼
  Express Server ──► Webhook Handlers
        │                   │
        ▼                   ▼
  Discord Bot        Actual Budget API
        │                   │
        ▼                   ▼
  Claude Agent ◄──── Budget Data
        │
        ▼
  Discord Thread + Email Alerts
```

- **Webhook server** — Express with HMAC-SHA256 authentication
- **AI agent** — Claude with tools for querying budget data and proposing changes
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
| `DISCORD_ALLOWED_USER_ID` | Discord user ID allowed to interact |
| `DISCORD_BUDGET_CHANNEL_ID` | Channel for budget alerts |
| `DISCORD_ERROR_CHANNEL_ID` | Channel for error notifications |
| `ACTUAL_SERVER_URL` | Actual Budget server URL |
| `ACTUAL_PASSWORD` | Actual Budget password |
| `ACTUAL_BUDGET_ID` | Budget sync ID |
| `SMTP_HOST` | SMTP relay host |
| `SMTP_PORT` | SMTP relay port |
| `EMAIL` | Sender email address |
| `WIFE_EMAIL` | Recipient for alerts/digests |
| `WEBHOOK_HMAC_KEY` | Shared secret for webhook authentication |
| `DATA_DIR` | Path for SQLite database and Actual sync data |
| `CONFIGMAP_PATH` | Path to settings.json for hot-reload config |

## Deployment

Deployed to Kubernetes via [Flux GitOps](https://fluxcd.io/). Container images are built by GitHub Actions on push to `main` and auto-deployed via Flux image automation. See the [hops](https://github.com/mwdavisii/hops) repo for k8s manifests.

## License

MIT
