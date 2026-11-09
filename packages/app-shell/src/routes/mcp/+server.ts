/**
 * `POST /mcp`: the one MCP endpoint (Streamable HTTP, stateless). Its catalog
 * is the shell's generated tools (App builder methods, Approval.decide and
 * pending) plus the user app's generated tools, under one owner-only policy
 * (`$lib/server/policy`). Risky calls (`<model>_delete`, risky builder
 * methods) return `pending_approval` and wait for the owner.
 *
 * Auth: the owner's session cookie, or an owner-minted local MCP token
 * (`Authorization: Bearer`). `tools/list` is not cached by clients: the
 * catalog changes with the app. This transport is stateless, so
 * `notifications/tools/list_changed` cannot be pushed here; live clients
 * (the UI, the assistant) learn of changes from `GET /api/events`.
 */
import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import {
  mountMcpRoute,
  principalFromSessionLocals,
} from '@happyvertical/smrt-app-mcp/sveltekit';
import { createShellMcpServer } from '$lib/server/mcp-server';
import { runtime } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

const handler = mountMcpRoute(createShellMcpServer(), {
  checkOrigin: true,
  resolvePrincipal: principalFromSessionLocals,
  auth: createHostedMcpResourceAuth({ profile: 'local', runtime }),
  bindPrincipal: (principal, run) => runtime.runAsPrincipal(principal, run),
});

export const POST: RequestHandler = (event) => handler(event as never);
