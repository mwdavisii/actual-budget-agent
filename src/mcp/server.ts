import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBudgetTools, type McpDeps } from './tools';

export function createBudgetMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'budget-gateway', version: '1.0.0' });
  registerBudgetTools(server, deps);
  return server;
}
