/**
 * `POST /mcp`: the one MCP endpoint (Streamable HTTP, stateless). Its catalog
 * is the shell's generated tools (App builder methods, Approval.decide and
 * pending) plus the user app's generated tools, under one owner-only policy
 * (`$lib/server/policy`). Risky calls (`<model>_delete`, risky builder
 * methods) return `pending_approval` and wait for the owner.
 *
 * Which copy of the app a client works on is named by the URL it was
 * configured with, never by state an earlier call left behind:
 *   /mcp                  the live app (default). While a draft is open its
 *                         structure is frozen: builder tools are refused,
 *                         naming the draft; record tools keep working.
 *   /mcp?target=draft     the open draft, for tools and builder alike (a draft
 *                         approves its own risky changes; live is untouched).
 *   /mcp?scope=assistant  the assistant's split, resolved per call from the
 *                         owner's state: builder tools on the draft when one is
 *                         open, record tools on the copy the owner is viewing.
 * Anything else is a 400.
 *
 * Auth: the owner's session cookie, or an owner-minted local MCP token
 * (`Authorization: Bearer`). `tools/list` is not cached by clients: the
 * catalog changes with each definition change. This transport is stateless,
 * so `notifications/tools/list_changed` cannot be pushed here; live clients
 * (the UI, the assistant) learn of changes from `GET /api/events`.
 */
import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import {
  mountMcpRoute,
  principalFromSessionLocals,
} from '@happyvertical/smrt-app-mcp/sveltekit';
import { assistantScope } from '$lib/server/assistant/scope';
import { errorResponse } from '$lib/server/http';
import { createShellMcpServer } from '$lib/server/mcp-server';
import { runtime } from '$lib/server/smrt';
import { mcpScopeKey, scopeFor } from '$lib/server/target';
import type { RequestHandler } from './$types';

const auth = createHostedMcpResourceAuth({ profile: 'local', runtime });

function mount(resolve: Parameters<typeof createShellMcpServer>[0]) {
  return mountMcpRoute(createShellMcpServer(resolve), {
    checkOrigin: true,
    resolvePrincipal: principalFromSessionLocals,
    auth,
    bindPrincipal: (principal, run) => runtime.runAsPrincipal(principal, run),
  });
}

type Handler = ReturnType<typeof mount>;
const handlers: Record<'live' | 'draft' | 'assistant', Handler> = {
  live: mount(() => scopeFor('live')),
  draft: mount(() => scopeFor('draft')),
  assistant: mount((principal) => assistantScope(principal)),
};

export const POST: RequestHandler = (event) => {
  let handler: Handler;
  try {
    handler = handlers[mcpScopeKey(event.url.searchParams)];
  } catch (error) {
    return Promise.resolve(errorResponse(error));
  }
  return handler(event as never);
};
