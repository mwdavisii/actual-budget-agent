import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { registerBudgetTools, type McpDeps } from './tools';
import { logger } from '../logger';

export { type McpDeps };

export function createBudgetMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'budget-gateway', version: '1.0.0' });
  registerBudgetTools(server, deps);
  return server;
}

export function createMcpRequestHandler(deps: McpDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = createBudgetMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless: one server+transport per request
      enableJsonResponse: true,        // return application/json instead of SSE
    });
    res.on('close', () => {
      transport.close().catch((e) => logger.warn('MCP transport close error', { error: String(e) }));
      server.close().catch((e) => logger.warn('MCP server close error', { error: String(e) }));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
