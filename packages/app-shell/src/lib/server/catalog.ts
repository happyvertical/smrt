// The merged tool catalog: the shell's generated tools (App builder methods,
// Approval.decide/pending) plus the user app's generated tools, one namespace.
// Listing and dispatch only; WHO may see or call them is policy.ts.
import {
  createDefaultMcpAppServer,
  type McpAppPrincipal,
  type McpAppServer,
} from '@happyvertical/smrt-app-mcp';
import { isRiskyTool } from '../../engine/index.ts';
import { App } from '../objects/App.ts';
import { Approval } from '../objects/Approval.ts';
import { runAppTool } from './builder.ts';
import { getHost, getShellDb, shellDbSync } from './host.ts';
import { runAs } from './owner.ts';

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: object;
  /** Which half serves the tool. */
  side: 'shell' | 'app';
  /** Calling it needs the owner's approval first (`<model>_delete`). */
  risky: boolean;
}

export interface CatalogResponse {
  content: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

let shellServer: McpAppServer | null = null;

/** The generated MCP server for the shell's own models. */
export function shellMcpServer(): McpAppServer {
  shellServer ??= createDefaultMcpAppServer({
    models: [App, Approval],
    // Principal-level checks (owner only) are policy.ts; the generated server
    // only needs an authenticated principal.
    requiredScopes: [],
    smrtOptions: () => ({ db: shellDbSync() }),
    serverInfo: { name: 'smrt-app-shell', version: '0.1.0' },
  });
  return shellServer;
}

/**
 * Shell tools no tool caller may have. Deciding an approval is the owner's act
 * in the UI (a signed-in session): a model-driven client (the assistant or an
 * outside agent on /mcp) must never approve its own risky call.
 */
export const NON_TOOL_METHODS: ReadonlySet<string> = new Set([
  'approval_decide',
]);

/** Tools of the shell's own models, for `principal`. */
export async function listShellTools(
  principal: McpAppPrincipal,
): Promise<CatalogTool[]> {
  await getShellDb();
  return (await shellMcpServer().listTools({ principal }))
    .filter((t) => !NON_TOOL_METHODS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      side: 'shell' as const,
      risky: false,
    }));
}

/** Tools of the user app, as the running worker generates them. */
export async function listAppTools(): Promise<CatalogTool[]> {
  const host = await getHost();
  return (await host.appTools()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    side: 'app' as const,
    risky: isRiskyTool(t.name),
    ...(isRiskyTool(t.name) ? { annotations: { destructiveHint: true } } : {}),
  }));
}

/** Everything, shell first; an app tool never shadows a shell tool. */
export async function listCatalog(
  principal: McpAppPrincipal,
): Promise<CatalogTool[]> {
  const shell = await listShellTools(principal);
  const taken = new Set(shell.map((t) => t.name));
  const app = (await listAppTools()).filter((t) => !taken.has(t.name));
  return [...shell, ...app].sort((a, b) => (a.name < b.name ? -1 : 1));
}

function asText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/** Dispatch a call to the half that owns `name`. Authorize BEFORE calling. */
export async function dispatchTool(
  principal: McpAppPrincipal & { id: string },
  tool: CatalogTool,
  args: Record<string, unknown>,
): Promise<CatalogResponse> {
  if (tool.side === 'shell') {
    await getShellDb();
    // The model methods check the owner from the async scope's tenant
    // context; run them as the very principal that was authorized.
    return runAs(
      { id: principal.id, tenantId: principal.tenantId ?? '' },
      async () =>
        (await shellMcpServer().callTool({
          name: tool.name,
          arguments: args,
          principal,
        })) as CatalogResponse,
    );
  }
  const out = await runAppTool(tool.name, args, principal.id);
  if (
    out &&
    typeof out === 'object' &&
    (out as { status?: unknown }).status === 'pending_approval'
  )
    return { content: asText(out), structuredContent: out };
  return out as CatalogResponse;
}
