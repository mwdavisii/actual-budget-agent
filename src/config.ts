function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export interface GatewayConfig {
  actualServerUrl: string;
  actualPassword: string;
  actualBudgetId: string;
  dataDir: string;
  gatewayToken: string;
  port: number;
  syncTtlSeconds: number;
}

export function getGatewayConfig(): GatewayConfig {
  return {
    actualServerUrl: requireEnv('ACTUAL_SERVER_URL'),
    actualPassword: requireEnv('ACTUAL_PASSWORD'),
    actualBudgetId: requireEnv('ACTUAL_BUDGET_ID'),
    dataDir: process.env['DATA_DIR'] ?? '/data',
    gatewayToken: requireEnv('GATEWAY_TOKEN'),
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    syncTtlSeconds: parseInt(process.env['SYNC_TTL_SECONDS'] ?? '45', 10),
  };
}
