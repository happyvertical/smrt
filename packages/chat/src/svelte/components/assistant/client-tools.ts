/**
 * Browser tools for the AssistantDock (#2908).
 *
 * The dock offers the model the page's own WebMCP tools — the same set an
 * outside agent sees — and runs the model's calls to them in the browser,
 * through the same registry, as the signed-in user. The page registry is
 * `@happyvertical/smrt-web/webmcp-page-tools`'s `WebMcpPageToolRegistry`,
 * which satisfies {@link AssistantClientToolSource} structurally (this
 * package keeps no runtime dependency on smrt-web).
 *
 * Whether a call runs at once or waits for the user is decided HERE, in the
 * browser, from the registry's own description of the tool — never from what
 * the server echoes back:
 *
 * - `read` runs;
 * - `destructive` always waits for the user's own confirmation;
 * - `write` runs only when the registry marks the tool `proposal: true` —
 *   smrt-web sets that solely from a module-private brand that compiled view
 *   intents and the fixed `smrt_ui_*` tools carry, because those tools only
 *   stage a value or dispatch a registry command as `source: 'agent'` (the
 *   control/surface registry keeps the change a proposal the user applies);
 * - any other `write` waits for the user's confirmation — including one whose
 *   `owner` label says `ui` or `intent`: that label is a diagnostic any
 *   bespoke registration can set, so it never grants auto-run.
 *
 * A host may narrow this with `clientToolPolicy`, but can never make a
 * destructive call run without confirmation.
 */

import type {
  AssistantClientToolDeclaration,
  AssistantToolEffect,
} from '../../../assistant-turn-events.js';

/** One live browser tool, as the page registry describes it. */
export interface AssistantClientTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: AssistantToolEffect;
  /**
   * The registration path (`generated`, `ui`, `intent`, `bespoke`), when
   * known. Diagnostic only — it never decides whether a write runs.
   */
  owner?: string;
  /**
   * True only for a registry-branded proposal-only tool (a compiled view
   * intent or a fixed `smrt_ui_*` tool). Absent or false means a write acts.
   */
  proposal?: boolean;
}

/** Where the dock finds and runs browser tools. */
export interface AssistantClientToolSource {
  list(): AssistantClientTool[];
  execute(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

/** Run now, or wait for the user's confirmation. */
export type AssistantClientToolPolicy = 'run' | 'confirm';

/** The default policy described in the module doc. */
export function defaultClientToolPolicy(
  tool: Pick<AssistantClientTool, 'effect' | 'owner' | 'proposal'>,
): AssistantClientToolPolicy {
  if (tool.effect === 'read') return 'run';
  if (tool.effect === 'destructive') return 'confirm';
  return tool.proposal === true ? 'run' : 'confirm';
}

/**
 * Apply a host policy without ever weakening the floor: a destructive tool is
 * always `confirm`, whatever the host says.
 */
export function resolveClientToolPolicy(
  tool: AssistantClientTool,
  hostPolicy?: (tool: AssistantClientTool) => AssistantClientToolPolicy,
): AssistantClientToolPolicy {
  if (tool.effect === 'destructive') return 'confirm';
  return hostPolicy ? hostPolicy(tool) : defaultClientToolPolicy(tool);
}

/** The declarations sent to the server with a turn (bounded). */
export function declareClientTools(
  tools: readonly AssistantClientTool[],
  limit = 64,
): AssistantClientToolDeclaration[] {
  return tools.slice(0, limit).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: tool.effect,
  }));
}

/** A browser tool call waiting for (or past) the user's decision. */
export interface AssistantToolRequest {
  /** The model's call id. */
  id: string;
  name: string;
  /** What the tool says it does (its registry description). */
  description: string;
  args: Record<string, unknown>;
  effect: AssistantToolEffect;
  status: 'waiting' | 'running' | 'done' | 'declined' | 'failed';
  error?: string;
}

/**
 * The name of the dock's own proposal tool. It lets the model PROPOSE an
 * action on a mounted data surface: the dock previews it and shows the usual
 * Confirm/Reject, so nothing changes until the user confirms. Add it to the
 * server's browser-tool allow-list to offer it.
 */
export const ASSISTANT_PROPOSE_ACTION_TOOL = 'assistant_propose_action';
