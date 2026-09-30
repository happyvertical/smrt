/** Explicit application workflow tools composed into an app MCP catalog. */
import {
  assertMcpJsonSchemaSafety,
  type MCPResponse,
  type MCPTool,
  type MCPToolIcon,
  mcpToolAnnotationsFor,
  type ToolEffect,
  type ToolJsonSchema,
} from '@happyvertical/smrt-core/generators/mcp';
import type { McpAppPrincipal } from './server.js';

/** Trusted server context supplied to an application-owned workflow handler. */
export interface McpWorkflowToolContext {
  arguments: Record<string, unknown>;
  principal: McpAppPrincipal | null;
}

/** Portable UI visibility hints. They are host presentation metadata only. */
export type McpWorkflowToolVisibility = 'app' | 'model';

/** One explicitly declared, principal-bound application workflow tool. */
export interface McpWorkflowToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  outputSchema: ToolJsonSchema;
  /** Required canonical classification; names and UI metadata never infer it. */
  effect: ToolEffect;
  idempotent: boolean;
  openWorld: boolean;
  title?: string;
  icons?: readonly MCPToolIcon[];
  /**
   * Portable MCP Apps presentation metadata. Resources themselves arrive in
   * M3; visibility-only declarations are useful for host entrypoints.
   */
  ui?: {
    resourceUri?: string;
    visibility?: readonly McpWorkflowToolVisibility[];
  };
  /** Preserved extension metadata. It is never used as an authorization input. */
  metadata?: Record<string, unknown>;
  execute(context: McpWorkflowToolContext): MCPResponse | Promise<MCPResponse>;
}

export interface McpWorkflowTool {
  tool: MCPTool;
  execute: McpWorkflowToolDefinition['execute'];
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be an object.`);
  }
}

const MAX_METADATA_DEPTH = 16;
const MAX_METADATA_BYTES = 65_536;

function assertJsonMetadata(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new TypeError(
      `Workflow tool metadata exceeds ${MAX_METADATA_DEPTH} levels.`,
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Workflow tool metadata numbers must be finite.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Workflow tool metadata must not contain cycles.');
    }
    ancestors.add(value);
    for (const item of value) assertJsonMetadata(item, depth + 1, ancestors);
    ancestors.delete(value);
    return;
  }
  assertRecord(value, 'Workflow tool metadata value');
  if (ancestors.has(value)) {
    throw new TypeError('Workflow tool metadata must not contain cycles.');
  }
  ancestors.add(value);
  for (const item of Object.values(value)) {
    assertJsonMetadata(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  assertRecord(metadata, 'Workflow tool metadata');
  if (Object.hasOwn(metadata, 'ui')) {
    throw new TypeError(
      'Workflow tool metadata.ui is reserved; use ui.resourceUri.',
    );
  }
  assertJsonMetadata(metadata);
  const encoded = JSON.stringify(metadata);
  if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
    throw new TypeError(
      `Workflow tool metadata exceeds ${MAX_METADATA_BYTES} serialized bytes.`,
    );
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function assertResourceUri(resourceUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(resourceUri);
  } catch {
    throw new TypeError(
      'Workflow tool ui.resourceUri must be an absolute URI.',
    );
  }
  if (parsed.protocol !== 'ui:' || parsed.username || parsed.password) {
    throw new TypeError(
      'Workflow tool ui.resourceUri must be a credential-free ui: URI.',
    );
  }
}

function normalizeVisibility(
  visibility: readonly McpWorkflowToolVisibility[] | undefined,
): McpWorkflowToolVisibility[] | undefined {
  if (visibility === undefined) return undefined;
  if (!Array.isArray(visibility) || visibility.length === 0) {
    throw new TypeError(
      'Workflow tool ui.visibility must be a non-empty array.',
    );
  }
  const normalized: McpWorkflowToolVisibility[] = [];
  for (const value of visibility) {
    if (value !== 'app' && value !== 'model') {
      throw new TypeError(
        'Workflow tool ui.visibility contains an unsupported value.',
      );
    }
    if (normalized.includes(value)) {
      throw new TypeError(
        'Workflow tool ui.visibility must not contain duplicates.',
      );
    }
    normalized.push(value);
  }
  return normalized;
}

function normalizeIcons(
  icons: readonly MCPToolIcon[] | undefined,
): MCPToolIcon[] | undefined {
  if (icons === undefined) return undefined;
  return icons.map((icon, index) => {
    assertRecord(icon, `Workflow tool icon ${index}`);
    if (typeof icon.src !== 'string' || !icon.src) {
      throw new TypeError(
        `Workflow tool icon ${index} requires a non-empty src.`,
      );
    }
    if (icon.mimeType !== undefined && typeof icon.mimeType !== 'string') {
      throw new TypeError(
        `Workflow tool icon ${index} mimeType must be a string.`,
      );
    }
    if (
      icon.theme !== undefined &&
      icon.theme !== 'light' &&
      icon.theme !== 'dark'
    ) {
      throw new TypeError(`Workflow tool icon ${index} theme is invalid.`);
    }
    if (
      icon.sizes !== undefined &&
      (!Array.isArray(icon.sizes) ||
        icon.sizes.some((size) => typeof size !== 'string'))
    ) {
      throw new TypeError(`Workflow tool icon ${index} sizes must be strings.`);
    }
    return { ...icon, ...(icon.sizes ? { sizes: [...icon.sizes] } : {}) };
  });
}

/** Validate and materialize an authored workflow as an inert MCP descriptor. */
export function createMcpWorkflowTool(
  definition: McpWorkflowToolDefinition,
): McpWorkflowTool {
  if (typeof definition.name !== 'string' || !TOOL_NAME.test(definition.name)) {
    throw new TypeError(
      'Workflow tool name must be lowercase snake_case with at most 64 characters.',
    );
  }
  if (
    typeof definition.description !== 'string' ||
    !definition.description.trim()
  ) {
    throw new TypeError('Workflow tool description must be non-empty.');
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError('Workflow tool execute must be a function.');
  }
  if (!['read', 'write', 'destructive'].includes(definition.effect)) {
    throw new TypeError(
      'Workflow tool effect must be read, write, or destructive.',
    );
  }
  if (
    typeof definition.idempotent !== 'boolean' ||
    typeof definition.openWorld !== 'boolean'
  ) {
    throw new TypeError(
      'Workflow tool idempotent and openWorld must be boolean.',
    );
  }
  if (
    definition.title !== undefined &&
    (typeof definition.title !== 'string' || !definition.title.trim())
  ) {
    throw new TypeError('Workflow tool title must be a non-empty string.');
  }
  assertRecord(definition.inputSchema, 'Workflow tool input schema');
  assertRecord(definition.outputSchema, 'Workflow tool output schema');
  assertMcpJsonSchemaSafety(definition.inputSchema);
  assertMcpJsonSchemaSafety(definition.outputSchema);
  const metadata = cloneMetadata(definition.metadata);
  if (definition.ui !== undefined) {
    assertRecord(definition.ui, 'Workflow tool ui');
    if (
      definition.ui.resourceUri === undefined &&
      definition.ui.visibility === undefined
    ) {
      throw new TypeError(
        'Workflow tool ui requires resourceUri or visibility metadata.',
      );
    }
    if (
      definition.ui.resourceUri !== undefined &&
      typeof definition.ui.resourceUri !== 'string'
    ) {
      throw new TypeError('Workflow tool ui.resourceUri must be a string.');
    }
    if (definition.ui.resourceUri !== undefined) {
      assertResourceUri(definition.ui.resourceUri);
    }
  }
  const icons = normalizeIcons(definition.icons);
  const visibility = normalizeVisibility(definition.ui?.visibility);
  const meta = {
    ...(metadata ?? {}),
    ...(definition.ui !== undefined
      ? {
          ui: {
            ...(definition.ui.resourceUri
              ? { resourceUri: definition.ui.resourceUri }
              : {}),
            ...(visibility ? { visibility } : {}),
          },
        }
      : {}),
  };
  return {
    tool: {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: mcpToolAnnotationsFor(
        definition.effect,
        definition.idempotent,
        definition.openWorld,
      ),
      ...(definition.title ? { title: definition.title } : {}),
      ...(icons ? { icons } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    },
    execute: definition.execute,
  };
}
