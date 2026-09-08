import type { FastifyInstance } from 'fastify';
import { installMcp, readMcpStatus, type McpStatus } from '../project/mcp-install.js';

/**
 * What these routes need of a session: the project's root, and nothing else.
 * Named here rather than as `Session` so `app.ts` can hand them
 * `host.current()` and this module asks for exactly the one field.
 */
export interface McpInstallSession {
  readonly root: string;
}

/**
 * `.mcp.json`, read and written — the MCP half of what `/api/hook-status` and
 * `/api/hook-install` do for the hook.
 *
 * They are the same pair on purpose. Both channels between codemap and an agent
 * were built and only one of them was one press away, which is how a project
 * with a working hook and no `.mcp.json` looked connected while the agent had
 * no tools at all.
 *
 * Consent is the hook's rule, unchanged: the file is written on a press and
 * never on a boot, a project switch or a status read. The direction is
 * unchanged too — this writes a config an agent will read when it next starts;
 * it does not reach an agent, and through MCP nothing can.
 */
export function registerMcpInstallRoutes(
  app: FastifyInstance,
  current: () => McpInstallSession,
): void {
  app.get('/api/mcp-status', async (): Promise<McpStatus> => readMcpStatus(current().root));

  app.post('/api/mcp-install', async (_request, reply) => {
    try {
      return await installMcp(current().root);
    } catch (error) {
      // Two ways it refuses, and both are the user's to act on: a `.mcp.json`
      // that is not valid JSON, and a build with no `scripts/mcp.mjs` beside it.
      // The message carries the path in either case.
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
