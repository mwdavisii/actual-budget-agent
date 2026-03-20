import fs from 'fs';
import { logger } from './logger';

export interface SecretsConfig {
  claudeApiKey: string;
  discordToken: string;
  smtpHost: string;
  smtpPort: number;
  email: string;
  wifeEmail: string;
  webhookHmacKey: string;
  discordAllowedUserId: string;
  discordBudgetChannelId: string;
  discordErrorChannelId: string;
  actualBudgetId: string;
  actualServerUrl: string;
  actualPassword: string;
  dataDir: string;
}

export interface DynamicConfig {
  overspendThresholdDollars: number;
  emailCategories: string[];
}

const CONFIGMAP_PATH = process.env.CONFIGMAP_PATH ?? '/config/settings.json';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getSecrets(): SecretsConfig {
  return {
    claudeApiKey: requireEnv('CLAUDE_API_KEY'),
    discordToken: requireEnv('DISCORD_TOKEN'),
    smtpHost: requireEnv('SMTP_HOST'),
    smtpPort: parseInt(requireEnv('SMTP_PORT'), 10),
    email: requireEnv('EMAIL'),
    wifeEmail: requireEnv('WIFE_EMAIL'),
    webhookHmacKey: requireEnv('WEBHOOK_HMAC_KEY'),
    discordAllowedUserId: requireEnv('DISCORD_ALLOWED_USER_ID'),
    discordBudgetChannelId: requireEnv('DISCORD_BUDGET_CHANNEL_ID'),
    discordErrorChannelId: requireEnv('DISCORD_ERROR_CHANNEL_ID'),
    actualBudgetId: requireEnv('ACTUAL_BUDGET_ID'),
    actualServerUrl: requireEnv('ACTUAL_SERVER_URL'),
    actualPassword: requireEnv('ACTUAL_PASSWORD'),
    dataDir: process.env['DATA_DIR'] ?? '/data',
  };
}

/** Re-reads the ConfigMap file on each call — supports hot-reload without pod restart. */
export function getDynamicConfig(): DynamicConfig {
  try {
    const raw = fs.readFileSync(CONFIGMAP_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as DynamicConfig;
    return {
      overspendThresholdDollars: parsed.overspendThresholdDollars ?? 50,
      emailCategories: parsed.emailCategories ?? ["Natalie's Spending", 'Dining Out', 'Groceries'],
    };
  } catch (err) {
    logger.warn('Failed to read ConfigMap — using defaults', { err: String(err) });
    return {
      overspendThresholdDollars: 50,
      emailCategories: ["Natalie's Spending", 'Dining Out', 'Groceries'],
    };
  }
}
