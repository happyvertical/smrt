// The merged tool catalog: the shell's generated tools (App builder methods,
// Approval.decide/pending) plus the user app's generated tools, one namespace.
// Listing and dispatch only; WHO may see or call them is policy.ts.

import {
  createDefaultMcpAppServer,
  type McpAppPrincipal,
  type McpAppServer,
} from '@happyvertical/smrt-app-mcp';
import {
  EngineError,
  FIELD_NAME_PATTERN,
  FIELD_TYPES,
  isRiskyTool,
  STRUCTURAL_COMMANDS,
} from '../../engine/index.ts';
import { App } from '../objects/App.ts';
import { Approval } from '../objects/Approval.ts';
import { collectIssuedApprovals, type PendingApproval } from './approvals.ts';
import { runAppTool } from './builder.ts';
import { reviseChangeCard } from './changes.ts';
import { ENGINE_TOOLS, isEngineTool, runEngineTool } from './engine-tools.ts';
import { getShellDb, hostFor, shellDbSync } from './host.ts';
import { HttpError } from './http.ts';
import { runAs } from './owner.ts';
import {
  type CallScope,
  LIVE_SCOPE,
  type Target,
  withScope,
} from './target.ts';

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
  /**
   * Set by `dispatchTool` only, never derived from content: this call was
   * turned into an Approval (by `requestApproval`). The assistant holds its
   * turn on this, not on what the result text looks like.
   */
  pending?: PendingApproval;
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

/**
 * The scanner turns `FieldDef` into a bare object, so a model sees no list of
 * types and invents them ('string', 'Text', 'ShortText'). These schemas are
 * the explicit tool-schema override for the builder tools that take fields.
 */
const FIELD_NAME_SCHEMA = {
  type: 'string',
  pattern: FIELD_NAME_PATTERN,
  description:
    'camelCase, e.g. dueDate: lowercase first letter, then letters and digits; no underscores or spaces',
};

export const FIELD_DEF_SCHEMA = {
  type: 'object',
  description:
    "One field. `type` is required. Use 'choice' with `choices`, and 'reference' with `ref` (a model of the app).",
  properties: {
    type: {
      type: 'string',
      enum: [...FIELD_TYPES],
      description:
        'text (words), number (decimal), integer (whole number), boolean (yes/no, done or not), date (a day or time), money (whole minor units such as cents), choice (one of `choices`), reference (id of a record of the model `ref`), json (structured data)',
    },
    label: { type: 'string', description: 'Name shown to people' },
    required: { type: 'boolean' },
    choices: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: "The allowed values; only for type 'choice'",
    },
    calculated: {
      type: 'object',
      description: 'Core generated expression (SQL SDK operand nodes)',
    },
    ref: {
      type: 'string',
      description: "A model of the app; only for type 'reference'",
    },
  },
  required: ['type'],
  additionalProperties: false,
};

const TYPES_TEXT = FIELD_TYPES.join(', ');
const BUILDER_SCHEMAS: Record<
  string,
  { description: string; props: Record<string, unknown> }
> = {
  app_definemodel: {
    description: `Add a model (a kind of record, e.g. Chore) with its fields. Model names are PascalCase. Field names are camelCase (e.g. dueDate, not due_date). Field types are exactly: ${TYPES_TEXT}. Example fields: {"title":{"type":"text","required":true},"dueDate":{"type":"date"},"done":{"type":"boolean"},"points":{"type":"integer"}}.`,
    props: {
      name: {
        type: 'string',
        pattern: '^[A-Z][A-Za-z0-9]{0,39}$',
        description: 'PascalCase, e.g. Chore',
      },
      fields: {
        type: 'object',
        description: 'Fields by name (camelCase keys)',
        propertyNames: FIELD_NAME_SCHEMA,
        additionalProperties: FIELD_DEF_SCHEMA,
      },
      label: { type: 'string' },
    },
  },
  app_addfield: {
    description: `Add one field to a model. The field name is camelCase (e.g. dueDate). Field types are exactly: ${TYPES_TEXT}.`,
    props: { field: FIELD_NAME_SCHEMA, definition: FIELD_DEF_SCHEMA },
  },
  app_changefieldtype: {
    description: `Change a field's type (needs the owner's approval). Pass the new field as "definition", like {"type":"integer"}; its type is exactly one of: ${TYPES_TEXT}.`,
    props: { field: FIELD_NAME_SCHEMA, definition: FIELD_DEF_SCHEMA },
  },
};

/** Replace the generated, vague schema of the builder tools that take fields. */
function withBuilderSchema<
  T extends { name: string; description?: string; inputSchema: unknown },
>(tool: T): T {
  const o = BUILDER_SCHEMAS[tool.name];
  if (!o) return tool;
  const base = (tool.inputSchema ?? {}) as {
    properties?: Record<string, unknown>;
  };
  return {
    ...tool,
    description: o.description,
    inputSchema: {
      ...base,
      properties: { ...(base.properties ?? {}), ...o.props },
    },
  };
}

/**
 * The one tool of a comment turn (#5206): replace the commands of the card the
 * turn is about. Hand-written (not an `App` method, so no REST/CLI/MCP is
 * generated), listed only while a comment turn is open, and it never applies.
 */
export const CHANGE_REVISE_TOOL: CatalogTool = {
  name: 'change_revise',
  description:
    'Replace the engine command of the ONE waiting change the owner commented on. `cardId` is that change; `command` is the new command object, like {"type":"addField","model":"Order","field":"fulfillment","definition":{"type":"choice","choices":["Pickup","Delivery"]}}. It only edits that change: it never applies anything, and the owner still reviews and applies.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: 'The id of the change.' },
      command: {
        type: 'object',
        description: 'One engine command, with its `type`.',
      },
    },
    required: ['cardId', 'command'],
    additionalProperties: false,
  },
  side: 'shell',
  risky: false,
};

/** Builder tool names for structural commands (`app_<type>`), as the assistant sees them. */
const STRUCTURAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(STRUCTURAL_COMMANDS)
    .filter(([, structural]) => structural)
    .map(([type]) => `app_${type.toLowerCase()}`),
);

/** Tools of the shell's own models, for `principal`. */
export async function listShellTools(
  principal: McpAppPrincipal,
): Promise<CatalogTool[]> {
  await getShellDb();
  const generated = (await shellMcpServer().listTools({ principal }))
    .filter((t) => !NON_TOOL_METHODS.has(t.name))
    .map(withBuilderSchema)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      side: 'shell' as const,
      risky: false,
    }));
  return [
    ...generated,
    ...ENGINE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object',
        properties: t.properties,
        required: [...t.required],
        additionalProperties: false,
      },
      side: 'shell' as const,
      risky: false,
    })),
  ];
}

/** Tools of the user app on one copy, as that copy's running worker generates them. */
export async function listAppTools(target: Target): Promise<CatalogTool[]> {
  const host = await hostFor(target);
  return (await host.appTools()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    side: 'app' as const,
    risky: isRiskyTool(t.name),
    ...(isRiskyTool(t.name) ? { annotations: { destructiveHint: true } } : {}),
  }));
}

/**
 * Everything, shell first; an app tool never shadows a shell tool. The app's
 * tools are those of the copy `scope.records` names (a draft can have models
 * live does not). Builder tools are the same for both copies; which copy they
 * change is `scope.structure`, applied at dispatch.
 */
export async function listCatalog(
  principal: McpAppPrincipal,
  scope: CallScope = LIVE_SCOPE,
): Promise<CatalogTool[]> {
  const shell = await listShellTools(principal);
  const taken = new Set(shell.map((t) => t.name));
  const app = (await listAppTools(scope.records)).filter(
    (t) => !taken.has(t.name),
  );
  const all = [...shell, ...app].sort((a, b) => (a.name < b.name ? -1 : 1));
  // A comment turn is about ONE card: read tools and change_revise only. No
  // structural builder tool (those make new cards) and no record writes.
  if (scope.reviseCardId)
    return [
      ...all.filter(
        (t) =>
          !STRUCTURAL_TOOL_NAMES.has(t.name) &&
          (t.side === 'shell' || /_(list|get)$/.test(t.name)),
      ),
      CHANGE_REVISE_TOOL,
    ].sort((a, b) => (a.name < b.name ? -1 : 1));
  return all;
}

function asText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/**
 * Dispatch a call to the half that owns `name`, on the copies `scope` names.
 * Authorize BEFORE calling.
 */
export async function dispatchTool(
  principal: McpAppPrincipal & { id: string },
  tool: CatalogTool,
  args: Record<string, unknown>,
  scope: CallScope = LIVE_SCOPE,
): Promise<CatalogResponse> {
  const { value, issued } = await collectIssuedApprovals(() =>
    dispatchInner(principal, tool, args, scope),
  );
  return issued.length ? { ...value, pending: issued[0] } : value;
}

async function dispatchInner(
  principal: McpAppPrincipal & { id: string },
  tool: CatalogTool,
  args: Record<string, unknown>,
  scope: CallScope,
): Promise<CatalogResponse> {
  if (tool.side === 'shell') {
    await getShellDb();
    // The model methods check the owner from the async scope's tenant
    // context; run them as the very principal that was authorized.
    // The builder methods read the copy from the scope entered here.
    return runAs({ id: principal.id, tenantId: principal.tenantId ?? '' }, () =>
      withScope(scope, async () => {
        if (tool.name === CHANGE_REVISE_TOOL.name) {
          // Only the card this turn was scoped to, whatever the model asks for.
          const cardId = scope.reviseCardId;
          const extra = Object.keys(args).filter(
            (k) => k !== 'cardId' && k !== 'command',
          );
          if (!cardId || args.cardId !== cardId || extra.length)
            throw new EngineError(
              'this turn can only change the one change you were asked about',
              'refused',
            );
          const value = await reviseChangeCard(cardId, args.command);
          return { content: asText(value), structuredContent: value };
        }
        if (isEngineTool(tool.name)) {
          try {
            const value = await runEngineTool(tool.name, args, scope);
            return { content: asText(value), structuredContent: value };
          } catch (error) {
            if (tool.name !== 'app_runreport' || !(error instanceof HttpError))
              throw error;
            // Only the report adapter's sanitized message crosses this boundary.
            // Both assistant engines retain it as an error, not a report result.
            const value = {
              kind: 'report_failure',
              summary: error.message,
              error: error.message,
            };
            return {
              isError: true,
              content: asText(value),
              structuredContent: value,
            };
          }
        }
        return (await shellMcpServer().callTool({
          name: tool.name,
          arguments: args,
          principal,
        })) as CatalogResponse;
      }),
    );
  }
  const out = await runAppTool(tool.name, args, principal.id, scope.records);
  if (
    out &&
    typeof out === 'object' &&
    (out as { status?: unknown }).status === 'pending_approval'
  )
    return { content: asText(out), structuredContent: out };
  return out as CatalogResponse;
}
