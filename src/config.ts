import fs from 'fs';
import { logger } from './logger';

export interface SecretsConfig {
  enableLlm: boolean;
  enablePayPeriodAllocation: boolean;
  enableSeedTargets: boolean;
  llmProvider: string;
  llmApiKey: string;
  llmModel?: string;
  discordToken: string;
  enableEmail: boolean;
  smtpHost: string;
  smtpPort: number;
  email: string;
  additionalEmails: string;
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
  proposalTtlHours: number;
  payFrequencyDays: number;
  lastPayDate: string;
}

const CONFIGMAP_PATH = process.env['CONFIGMAP_PATH'];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function envDefaults(): DynamicConfig {
  const categories = process.env['EMAIL_CATEGORIES'];
  return {
    overspendThresholdDollars: parseInt(process.env['OVERSPEND_THRESHOLD_DOLLARS'] ?? '50', 10),
    emailCategories: categories ? categories.split(',').map((s) => s.trim()) : ['Dining Out', 'Groceries'],
    proposalTtlHours: parseInt(process.env['PROPOSAL_TTL_HOURS'] ?? '24', 10),
    payFrequencyDays: parseInt(process.env['PAY_FREQUENCY_DAYS'] ?? '14', 10),
    lastPayDate: process.env['LAST_PAY_DATE'] ?? '2025-01-03',
  };
}

export function getSecrets(): SecretsConfig {
  const enableEmail = (process.env['ENABLE_EMAIL'] ?? 'false').toLowerCase() === 'true';
  const enableLlm = (process.env['ENABLE_LLM'] ?? 'true').toLowerCase() === 'true';
  const enablePayPeriodAllocation = (process.env['ENABLE_PAY_PERIOD_ALLOCATION'] ?? 'true').toLowerCase() === 'true';
  const enableSeedTargets = (process.env['ENABLE_SEED_TARGETS'] ?? 'true').toLowerCase() === 'true';
  return {
    enableLlm,
    enablePayPeriodAllocation,
    enableSeedTargets,
    llmProvider: process.env['LLM_PROVIDER'] ?? 'anthropic',
    llmApiKey: enableLlm ? requireEnv('LLM_API_KEY') : (process.env['LLM_API_KEY'] ?? ''),
    llmModel: process.env['LLM_MODEL'] || undefined,
    discordToken: requireEnv('DISCORD_TOKEN'),
    enableEmail,
    smtpHost: enableEmail ? requireEnv('SMTP_HOST') : (process.env['SMTP_HOST'] ?? ''),
    smtpPort: enableEmail ? parseInt(requireEnv('SMTP_PORT'), 10) : 587,
    email: enableEmail ? requireEnv('EMAIL') : (process.env['EMAIL'] ?? ''),
    additionalEmails: enableEmail ? requireEnv('ADDITIONAL_EMAILS') : (process.env['ADDITIONAL_EMAILS'] ?? ''),
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

/**
 * Reads config from env vars, with optional settings.json file override.
 * If CONFIGMAP_PATH is set and the file exists, file values take precedence.
 * Re-reads the file on each call to support hot-reload.
 */
export function getDynamicConfig(): DynamicConfig {
  const defaults = envDefaults();
  if (!CONFIGMAP_PATH) return defaults;

  try {
    const raw = fs.readFileSync(CONFIGMAP_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DynamicConfig>;
    return {
      overspendThresholdDollars: parsed.overspendThresholdDollars ?? defaults.overspendThresholdDollars,
      emailCategories: parsed.emailCategories ?? defaults.emailCategories,
      proposalTtlHours: parsed.proposalTtlHours ?? defaults.proposalTtlHours,
      payFrequencyDays: parsed.payFrequencyDays ?? defaults.payFrequencyDays,
      lastPayDate: parsed.lastPayDate ?? defaults.lastPayDate,
    };
  } catch (err) {
    logger.warn('Failed to read config file — using env/defaults', { path: CONFIGMAP_PATH, err: String(err) });
    return defaults;
  }
}
