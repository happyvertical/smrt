/**
 * Runtime bootstrap template for generated MCP servers
 *
 * This template provides stdio transport integration for SMRT-generated MCP servers.
 * It handles:
 * - Server initialization with @modelcontextprotocol/server v2
 * - Tool registration from MCPGenerator
 * - Stdio transport connection
 * - Error handling and logging
 * - Graceful shutdown
 */

import type { CustomActionScope } from './custom-action.js';
import type { MCPConfig, MCPContext } from './mcp.js';

/**
 * Helper function to capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export interface RuntimeOptions {
  /** Server name (defaults to package name) */
  name?: string;

  /** Server version (defaults to package version) */
  version?: string;

  /** Server description */
  description?: string;

  /** MCP generator configuration */
  config?: MCPConfig;

  /** MCP context (database, AI client, etc.) */
  context?: MCPContext;

  /** Enable debug logging */
  debug?: boolean;

  /** Static tool definitions (generated at build time) */
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
  /** Cache hint emitted for deploy-static tools/list results. */
  toolListCacheHint?: {
    ttlMs: number;
    cacheScope: 'private' | 'public';
  };
  /** Internal invocation metadata; never exposed by the MCP tools/list result. */
  customActions?: Record<
    string,
    {
      scope: CustomActionScope;
      isStatic: boolean;
      /** Declared method name; tool IDs are lowercased protocol aliases. */
      methodName?: string;
      parameterNames?: string[];
      optionsParameter?: boolean;
      legacyOptions: boolean;
    }
  >;
  /** Task-enabled item custom actions. Never emitted in tools/list. */
  taskActions?: Record<
    string,
    {
      objectName: string;
      objectType: string;
    }
  >;

  /**
   * Lowercased simple names of objects that are `@TenantScoped` (#1554). When
   * non-empty, the generated server imports the tenancy fail-closed gate and
   * wraps tenant-scoped tool calls so a stdio invocation cannot read across all
   * tenants. The tenant is sourced from `SMRT_MCP_TENANT_ID` /
   * `SMRT_MCP_ALLOW_CROSS_TENANT` env vars (this server has no auth principal).
   */
  tenantScopedObjects?: string[];

  /**
   * Build-time approved STI discriminators, keyed by the lowercased MCP object
   * prefix. The generated runtime uses this instead of searching an initially
   * empty registry, then loads the approved qualified type through the public
   * collection API.
   */
  stiTargets?: Record<string, Record<string, string>>;
}

/**
 * Generate runtime bootstrap code for MCP server
 *
 * @param options - Runtime configuration options
 * @returns TypeScript code for server entry point
 */
export function generateRuntimeBootstrap(options: RuntimeOptions = {}): string {
  const {
    name = 'smrt-mcp-server',
    version = '1.0.0',
    description = 'Auto-generated MCP server from SMRT objects',
    debug = false,
    tools = [],
    customActions = {},
    taskActions = {},
    tenantScopedObjects = [],
    stiTargets = {},
    toolListCacheHint = { ttlMs: 86_400_000, cacheScope: 'private' },
  } = options;

  // Generate static tool array as TypeScript code
  const toolsCode = tools.length > 0 ? JSON.stringify(tools, null, 2) : '[]';
  const hasTaskActions = Object.keys(taskActions).length > 0;

  // Fail-closed tenant context (#1554): only wire the tenancy gate when at
  // least one exposed object is tenant-scoped, so apps without tenancy never
  // get a dangling import.
  const tenantScopedSet = Array.from(
    new Set(tenantScopedObjects.map((n) => n.toLowerCase())),
  );
  const hasTenantScoped = tenantScopedSet.length > 0;

  // Generate static switch cases using shared helper
  const generateSwitchCases = (indent: string) => {
    return tools
      .map((tool) => {
        const separator = tool.name.indexOf('_');
        const objectName = tool.name.slice(0, separator);
        const action = tool.name.slice(separator + 1);

        switch (action) {
          case 'list':
            return `${indent}case '${tool.name}': {
${indent}  const limit = args.limit ?? 50;
${indent}  const offset = args.offset ?? 0;
${indent}  const where = args.where ?? {};

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const items = await collection.list({ where, limit, offset });
${indent}  const itemsPublic = items.map((item) => item.toPublicJSON(PUBLIC_JSON_OPTIONS));
${indent}  const structuredContent = {
${indent}    data: itemsPublic,
${indent}    meta: { total: await collection.count({ where }), limit, offset, count: items.length },
${indent}  };
${indent}  return successResult(structuredContent, JSON.stringify(itemsPublic));
${indent}}`;

          case 'get':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id && !args.slug) {
${indent}    throw new Error('Either id or slug is required');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const filter = args.id || args.slug;
${indent}  const item = await collection.get(filter);

${indent}  if (!item) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  return successResult(item.toPublicJSON(PUBLIC_JSON_OPTIONS));
${indent}}`;

          case 'create':
            return `${indent}case '${tool.name}': {
${indent}  const { collection, objectName: targetObjectName } = await resolveCreateTarget('${objectName}', args, aiConfig);

${indent}  const newItem = await collection.create(applyWritablePolicy(targetObjectName, args));
${indent}  await newItem.save();

${indent}  return successResult(newItem.toPublicJSON(PUBLIC_JSON_OPTIONS));
${indent}}`;

          case 'update':
            return `${indent}case '${tool.name}': {
${indent}  const { id, ...updateData } = args;
${indent}  if (!id) {
${indent}    throw new Error('ID is required for update');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const existing = await collection.get(id);
${indent}  if (!existing) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  Object.assign(existing, applyWritablePolicy('${capitalize(objectName)}', updateData));
${indent}  await existing.save();

${indent}  return successResult(existing.toPublicJSON(PUBLIC_JSON_OPTIONS));
${indent}}`;

          case 'delete':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id) {
${indent}    throw new Error('ID is required for delete');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const toDelete = await collection.get(args.id);
${indent}  if (!toDelete) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  await toDelete.delete();

${indent}  return successResult({ success: true, message: 'Object deleted successfully' });
${indent}}`;

          default:
            // Custom action. Its descriptor is deliberately kept separate
            // from TOOLS so MCP clients receive only protocol-defined fields.
            return `${indent}case '${tool.name}': {
${indent}  const actionMeta = CUSTOM_ACTIONS['${tool.name}'] || { scope: 'item', isStatic: false, legacyOptions: true };
${indent}  const { id, options, ...directArgs } = args;

${indent}  if (actionMeta.scope === 'item' && !id) {
${indent}    throw new Error('ID is required for custom action ${action}');
${indent}  }
${indent}  if (actionMeta.scope === 'collection' && id) {
${indent}    throw new Error('Custom action ${action} is collection-scoped and does not accept an ID');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const target = actionMeta.scope === 'item'
${indent}    ? await collection.get(id)
${indent}    : actionMeta.isStatic
${indent}      ? ObjectRegistry.getClass('${capitalize(objectName)}')?.constructor
${indent}      : collection;
${indent}  if (!target) {
${indent}    throw new Error(actionMeta.scope === 'item' ? 'Object not found' : 'Custom action target not found');
${indent}  }
${indent}  const actionMethod = target[actionMeta.methodName || '${action}'];
${indent}  if (typeof actionMethod !== 'function') {
${indent}    throw new Error('Method ${action} not found on custom action target');
${indent}  }

${indent}  const methodArgs = actionMeta.legacyOptions
${indent}    ? [Object.keys(options ?? {}).length > 0 ? options : directArgs]
${indent}    : actionMeta.optionsParameter
${indent}      ? [options]
${indent}      : (actionMeta.parameterNames || []).map((parameterName) => args[
${indent}          parameterName === 'id'
${indent}            ? 'actionId'
${indent}            : parameterName
${indent}        ]);
${indent}  const result = await actionMethod.call(target, ...methodArgs);
${indent}  const failure = normalizeCustomActionFailure(result);
${indent}  if (failure) {
${indent}    return errorResult(
${indent}      { error: failure },
${indent}      JSON.stringify({ error: failure }),
${indent}      { [SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY]: failure },
${indent}    );
${indent}  }

${indent}  const publicResult = toPublicResult(result);
${indent}  return successResult({ data: publicResult }, JSON.stringify(publicResult));
${indent}}`;
        }
      })
      .join('\n\n');
  };

  const switchCases = generateSwitchCases('          ');

  return `#!/usr/bin/env node
/**
 * Auto-generated MCP Server
 * Generated by @smrt/core MCPGenerator
 *
 * This server exposes SMRT objects as MCP tools for AI integration.
 *
 * SECURITY (#1540): tool responses exclude @field({ sensitive }) fields and
 * create/update bodies are mass-assignment guarded. This stdio server has NO
 * per-call authentication principal — its trust boundary is the host process /
 * MCP client that launches it. Run it only in a trusted context, or front it
 * with an authenticated gateway. Do not expose it directly to untrusted callers.
 */

import {
  type CallToolRequest,
  type ListToolsRequest,
  Server,
  ${hasTaskActions ? 'specTypeSchemas,' : ''}
} from '@modelcontextprotocol/server';
import { ${hasTaskActions ? 'StdioServerTransport, ' : ''}serveStdio } from '@modelcontextprotocol/server/stdio';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { normalizeCustomActionFailure, SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY } from '@happyvertical/smrt-core';
import { loadConfig } from '@happyvertical/smrt-config';
${hasTaskActions ? "import { McpTaskStore, TaskRunner } from '@happyvertical/smrt-jobs';\n" : ''}
${hasTenantScoped ? "import { enableTenancy, runTenantScopedEntryPoint } from '@happyvertical/smrt-tenancy';\n" : ''}
// Server configuration
const SERVER_NAME = ${JSON.stringify(name)};
const SERVER_VERSION = ${JSON.stringify(version)};
const SERVER_DESCRIPTION = ${JSON.stringify(description)};
const DEBUG = ${debug};

// Static tool definitions (generated at build time)
const TOOLS = ${toolsCode};
const TOOL_LIST_CACHE_HINT = ${JSON.stringify(toolListCacheHint)};
const CUSTOM_ACTIONS = ${JSON.stringify(customActions)};
const TASK_ACTIONS = ${JSON.stringify(taskActions)};
const STI_TARGETS: Record<string, Record<string, string>> = ${JSON.stringify(stiTargets)};
${
  hasTenantScoped
    ? `
// Fail-closed tenant context (#1554): tenant-scoped objects must run inside a
// tenant. This stdio server has no auth principal, so the tenant is taken from
// the environment; without it (and with tenancy enabled) tenant-scoped tools
// throw rather than reading across all tenants.
const TENANT_SCOPED = new Set(${JSON.stringify(tenantScopedSet)});
const MCP_TENANT_ID = process.env.SMRT_MCP_TENANT_ID || undefined;
const MCP_ALLOW_CROSS_TENANT = process.env.SMRT_MCP_ALLOW_CROSS_TENANT === 'true';
`
    : ''
}
const PUBLIC_JSON_OPTIONS = {
  permissions: (process.env.SMRT_MCP_PERMISSIONS || '')
    .split(',')
    .map((permission) => permission.trim())
    .filter(Boolean),
};

/**
 * Mass-assignment guard (#1540): strip framework/server-managed and
 * \`@field({ readonly: true })\` fields from create/update bodies, intersecting
 * with the optional \`@smrt({ api: { writable: [...] } })\` allowlist.
 */
function applyWritablePolicy(objectName: string, data: any): Record<string, any> {
  if (!data || typeof data !== 'object') return {};
  const serverManaged = new Set([
    'id', 'tenantId', 'tenant_id',
    'createdAt', 'created_at', 'updatedAt', 'updated_at',
  ]);
  const readonly = new Set<string>();
  let writable: string[] | null = null;
  const apiConfig = ObjectRegistry.getConfig(objectName)?.api as any;
  if (apiConfig && typeof apiConfig === 'object' && Array.isArray(apiConfig.writable)) {
    writable = apiConfig.writable;
  }
  for (const [name, def] of ObjectRegistry.getFields(objectName)) {
    if (def && ((def as any).readonly === true || (def as any)._meta?.readonly === true)) {
      readonly.add(name);
    }
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    if (serverManaged.has(key)) continue;
    if (readonly.has(key)) continue;
    if (writable && !writable.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Resolve an advertised STI discriminator to its registered subtype collection. */
async function resolveCreateTarget(baseObjectName: string, args: Record<string, any>, aiConfig: any) {
  let objectName = baseObjectName;
  const discriminator = args._meta_type;
  const targets = STI_TARGETS[baseObjectName];
  if (typeof discriminator === 'string' && targets) {
    const target = targets[discriminator];
    if (!target) throw new Error('Unknown STI discriminator: ' + discriminator);
    objectName = target;
  }
  const collection = await ObjectRegistry.getCollection(objectName, {
    persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
    ai: aiConfig,
  });
  return { collection, objectName };
}

/**
 * Sensitive-field-safe serialization for custom-action results (#1540).
 * Recurses through arrays and plain objects so nested SmrtObjects are stripped
 * too; non-plain instances (Date, etc.) and primitives pass through. Cycle-safe.
 */
function toPublicResult(value: any, seen: WeakSet<object> = new WeakSet()): any {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toPublicJSON === 'function') return value.toPublicJSON(PUBLIC_JSON_OPTIONS);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry: any) => toPublicResult(entry, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toPublicResult(entry, seen);
  }
  return out;
}

function successResult(structuredContent: any, text = JSON.stringify(structuredContent)) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function errorResult(structuredContent: any, text: string, _meta?: Record<string, any>) {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent,
    ...(_meta ? { _meta } : {}),
  };
}

${
  hasTaskActions
    ? `
// The bundled SDK validates tools/call responses against its older result
// codec, which does not yet know CreateTaskResult. Intercept the extension at
// the transport boundary, then pass every non-task message untouched to the
// SDK server. This keeps ordinary MCP behaviour and version negotiation owned
// by the SDK while making the extension available today.
const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
let taskRuntime: Promise<{ store: McpTaskStore; runner: TaskRunner }> | undefined;

function clientSupportsTasks(message: any): boolean {
  return message?.params?._meta?.['io.modelcontextprotocol/clientCapabilities']
    ?.extensions?.[MCP_TASKS_EXTENSION] !== undefined;
}

/** Validate the 2026 request envelope before task dispatch mutates a job. */
function taskEnvelopeError(message: any): { code: number; message: string; data?: any } | undefined {
  const meta = message?.params?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return {
      code: -32602,
      message: 'Request is missing the required _meta envelope for protocol revision 2026-07-28',
    };
  }
  const protocolVersion = meta['io.modelcontextprotocol/protocolVersion'];
  if (protocolVersion !== '2026-07-28') {
    return typeof protocolVersion === 'string'
      ? {
          code: -32022,
          message: 'Unsupported protocol version: ' + protocolVersion,
          data: { supported: ['2026-07-28'], requested: protocolVersion },
        }
      : {
          code: -32602,
          message: 'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/protocolVersion must be a string',
        };
  }
  if (!specTypeSchemas.ClientCapabilities.safeParse(
    meta['io.modelcontextprotocol/clientCapabilities'],
  ).success) {
    return {
      code: -32602,
      message: 'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities is invalid',
    };
  }
  if (
    meta['io.modelcontextprotocol/clientInfo'] !== undefined &&
    !specTypeSchemas.Implementation.safeParse(
      meta['io.modelcontextprotocol/clientInfo'],
    ).success
  ) {
    return {
      code: -32602,
      message: 'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientInfo is invalid',
    };
  }
  if (
    meta['io.modelcontextprotocol/logLevel'] !== undefined &&
    !specTypeSchemas.LoggingLevel.safeParse(
      meta['io.modelcontextprotocol/logLevel'],
    ).success
  ) {
    return {
      code: -32602,
      message: 'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/logLevel is invalid',
    };
  }
  if (
    meta.progressToken !== undefined &&
    !specTypeSchemas.ProgressToken.safeParse(meta.progressToken).success
  ) {
    return {
      code: -32602,
      message: 'Invalid _meta envelope for protocol revision 2026-07-28: progressToken is invalid',
    };
  }
  return undefined;
}

function jsonRpcError(id: any, code: number, message: string, data?: any) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function getTaskRuntime() {
  if (!taskRuntime) {
    taskRuntime = (async () => {
      const firstAction = Object.values(TASK_ACTIONS)[0] as { objectName: string } | undefined;
      if (!firstAction) throw new Error('No task-enabled MCP action is configured');
      const collection = await ObjectRegistry.getCollection(firstAction.objectName, {
        persistence: { type: process.env.DATABASE_TYPE || 'sqlite', url: process.env.DATABASE_URL || ':memory:' },
      });
      const db = collection.db;
      const store = await McpTaskStore.create(db, { ownerId: process.env.SMRT_MCP_TENANT_ID || null });
      const runner = new TaskRunner({ queues: ['mcp-tasks'] });
      await runner.initialize(db);
      await runner.start();
      return { store, runner };
    })();
  }
  return taskRuntime;
}

function taskInvocationArgs(actionMeta: any, args: Record<string, any>): any[] {
  const { id: _id, options, ...directArgs } = args;
  if (actionMeta.legacyOptions) {
    return [Object.keys(options ?? {}).length > 0 ? options : directArgs];
  }
  if (actionMeta.optionsParameter) return [options];
  const parameterNames = actionMeta.parameterNames || [];
  const invocationParameterNames = parameterNames.at(-1) === 'context'
    ? parameterNames.slice(0, -1)
    : parameterNames;
  return invocationParameterNames.map((parameterName: string) =>
    args[parameterName === 'id' ? 'actionId' : parameterName],
  );
}

async function handleTaskExtensionMessage(message: any): Promise<any | null> {
  if (!message || typeof message !== 'object' || message.id === undefined) return null;
  const method = message.method;
  const params = message.params ?? {};
  const action = method === 'tools/call' ? TASK_ACTIONS[params.name] : undefined;
  const isTaskMethod = action || ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method);
  if (!isTaskMethod) return null;
  // A task-enabled tool retains its normal synchronous behaviour until its
  // client explicitly opts into Tasks. Do not impose the task envelope on
  // legacy calls that will be passed untouched to the SDK.
  if (!clientSupportsTasks(message) && method === 'tools/call') return null;
  const envelopeError = taskEnvelopeError(message);
  if (envelopeError) {
    return jsonRpcError(message.id, envelopeError.code, envelopeError.message, envelopeError.data);
  }
  if (!clientSupportsTasks(message)) {
    // A task-only method cannot fall back to a legacy response shape. A task
    // tool can still run normally when the client did not opt in, so let the
    // SDK handle that direct tools/call path.
    if (method === 'tools/call') return null;
    return jsonRpcError(message.id, -32021, 'Missing required client capability', {
      requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
    });
  }
  try {
    const { store } = await getTaskRuntime();
    if (action) {
      if (typeof params.arguments?.id !== 'string') {
        return jsonRpcError(message.id, -32602, 'Task-enabled custom actions require an id');
      }
      const actionMeta = CUSTOM_ACTIONS[params.name];
      const task = await store.createTask({
        objectType: action.objectType,
        objectId: params.arguments.id,
        method: actionMeta.methodName || params.name.slice(params.name.indexOf('_') + 1),
        invocationArgs: taskInvocationArgs(actionMeta, params.arguments),
        tenantId: ${hasTenantScoped ? 'MCP_TENANT_ID ?? null' : 'null'},
      });
      return { jsonrpc: '2.0', id: message.id, result: { resultType: 'task', content: [], structuredContent: {}, ...task } };
    }
    if (typeof params.taskId !== 'string') {
      return jsonRpcError(message.id, -32602, 'taskId is required');
    }
    if (method === 'tasks/get') {
      const task = await store.getTask(params.taskId);
      return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', ...task } };
    }
    if (method === 'tasks/update') {
      await store.updateTask(
        params.taskId,
        params.inputResponses && typeof params.inputResponses === 'object'
          ? params.inputResponses
          : {},
      );
      return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete' } };
    }
    await store.cancelTask(params.taskId);
    return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete' } };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Task operation failed';
    return jsonRpcError(message.id, -32602, messageText);
  }
}

class McpTaskExtensionTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;

  constructor(private readonly wire: StdioServerTransport) {}

  async start() {
    this.wire.onclose = () => this.onclose?.();
    this.wire.onerror = (error) => this.onerror?.(error);
    this.wire.onmessage = (message) => {
      void (async () => {
        const response = await handleTaskExtensionMessage(message);
        if (response) await this.wire.send(response);
        else this.onmessage?.(message);
      })().catch((error) => this.onerror?.(error instanceof Error ? error : new Error(String(error))));
    };
    await this.wire.start();
  }

  close() { return this.wire.close(); }
  send(message: any) { return this.wire.send(message); }
}
`
    : ''
}

/**
 * Main server startup function
 */
export async function createServer(): Promise<Server> {
    if (DEBUG) {
      console.error(\`[MCP] Starting server: \${SERVER_NAME} v\${SERVER_VERSION}\`);
    }
${
  hasTenantScoped
    ? `
    // Fail-closed tenant context (#1554): install the tenancy interceptor so
    // tenant-scoped tools are actually filtered, and so the entry-point gate
    // throws (rather than passing through) when no tenant is supplied. Without
    // this, a tenant set via SMRT_MCP_TENANT_ID would only set async context
    // with no interceptor to enforce it.
    enableTenancy();
`
    : ''
}
    // Register the application package manifest before resolving generated
    // object names. Generated servers are commonly run from the application
    // package itself, which is not a node_modules dependency of its process.
    const localManifestPaths = [
      resolve(process.cwd(), 'dist', 'manifest.json'),
      resolve(process.cwd(), '.smrt', 'manifest.json'),
    ].filter(existsSync);
    if (localManifestPaths.length > 0) {
      ObjectRegistry.loadAllManifests({ manifestPaths: localManifestPaths });
    }

    // A manifest supplies schemas and tool metadata, while an executable
    // custom action also needs the application's actual class constructor.
    // Consumer builds generate this registration module; load it after the
    // manifest so decorators enrich the already-known metadata.
    const localRegisterPath = process.env.SMRT_MCP_REGISTER_PATH
      || resolve(process.cwd(), '.smrt', 'register.js');
    if (existsSync(localRegisterPath)) {
      await import(pathToFileURL(localRegisterPath).href);
    }

    // Load configuration from environment and .smrt.config files
    const appConfig = await loadConfig();
    const aiConfig = appConfig?.ai || {};

    if (DEBUG) {
      console.error(\`[MCP] Loaded \${TOOLS.length} static tools\`);
      console.error(\`[MCP] Available tools:\`, TOOLS.map(t => t.name).join(', '));
    }

    // Create MCP server
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          ${hasTaskActions ? "extensions: { 'io.modelcontextprotocol/tasks': {} }," : ''}
        },
        cacheHints: {
          'tools/list': TOOL_LIST_CACHE_HINT,
        },
      }
    );

    // Register ListTools handler
    server.setRequestHandler('tools/list', async (_request: ListToolsRequest) => {
      if (DEBUG) {
        console.error(\`[MCP] ListTools request received\`);
      }

      return {
        tools: [...TOOLS].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      };
    });

    // Register CallTool handler
    server.setRequestHandler('tools/call', async (request: CallToolRequest) => {
      const { name: toolName, arguments: args = {} } = request.params;

      if (DEBUG) {
        console.error(\`[MCP] CallTool request: \${toolName}\`);
        console.error(\`[MCP] Arguments:\`, JSON.stringify(args, null, 2));
      }

      try {
        // Static switch statement for tool execution
        const runToolBody = async () => {
          switch (toolName) {
${switchCases}

            default:
              throw new Error(\`Unknown tool: \${toolName}\`);
          }
        };
${
  hasTenantScoped
    ? `
        // Fail-closed tenant context for tenant-scoped tools (#1554).
        const [toolObject] = toolName.split('_');
        const result =
          toolObject && TENANT_SCOPED.has(toolObject.toLowerCase())
            ? await runTenantScopedEntryPoint(
                { tenantScoped: true, tenantId: MCP_TENANT_ID, allowCrossTenant: MCP_ALLOW_CROSS_TENANT, surface: 'MCP' },
                runToolBody,
              )
            : await runToolBody();`
    : `
        const result = await runToolBody();`
}

        if (DEBUG) {
          console.error(\`[MCP] Tool executed successfully: \${toolName}\`);
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(\`[MCP] Tool execution failed: \${toolName}\`, error);

        return errorResult(
          { error: { message: errorMessage } },
          \`Error executing tool \${toolName}: \${errorMessage}\`,
        );
      }
    });

    return server;
}

async function main() {
  try {
    // Initialize the registry before accepting an intercepted task call. The
    // SDK would normally invoke this factory for the first regular message,
    // but task calls can be the first message on a stdio connection.
    const server = await createServer();
    const transport = ${hasTaskActions ? 'new McpTaskExtensionTransport(new StdioServerTransport())' : 'undefined'};
    const handle = serveStdio(() => server, {
      ...(transport ? { transport } : {}),
      onerror: (error) => console.error('[MCP] Protocol error:', error),
    });
    const shutdown = async () => {
      if (DEBUG) console.error('[MCP] Shutting down gracefully');
      ${hasTaskActions ? 'if (taskRuntime) {\n        const { runner } = await taskRuntime;\n        await runner.stop();\n      }' : ''}
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[MCP] Fatal error during server startup:', error);
    process.exit(1);
  }
}

// Start only when executed, so adapters and tests may import the factory.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[MCP] Unhandled error:', error);
    process.exit(1);
  });
}
`;
}

/**
 * Generate package.json script for running MCP server
 *
 * @param serverPath - Path to generated server file (relative to package root)
 * @returns Script command for package.json
 */
export function generateMCPScript(
  serverPath: string = 'dist/mcp-server.js',
): string {
  return `node ${serverPath}`;
}

/**
 * Generate Claude Desktop configuration example
 *
 * @param serverName - Name for the MCP server
 * @param serverPath - Absolute path to server file
 * @returns Configuration object for claude_desktop_config.json
 */
export function generateClaudeConfig(
  serverName: string,
  serverPath: string,
): object {
  return {
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: [serverPath],
      },
    },
  };
}

/**
 * Generate README documentation for MCP server setup
 *
 * @param serverName - Name of the MCP server
 * @param serverPath - Path to the server file
 * @returns Markdown documentation
 */
export function generateMCPDocumentation(
  serverName: string,
  serverPath: string,
): string {
  return `# MCP Server Setup

This project includes an auto-generated MCP (Model Context Protocol) server that exposes SMRT objects as tools for AI integration.

## Quick Start

### 1. Build the MCP Server

\`\`\`bash
npm run build
\`\`\`

This generates the MCP server at: \`${serverPath}\`

### 2. Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: \`~/.config/Claude/claude_desktop_config.json\`
**Windows**: \`%APPDATA%\\Claude\\claude_desktop_config.json\`

\`\`\`json
{
  "mcpServers": {
    "${serverName}": {
      "command": "node",
      "args": ["/absolute/path/to/${serverPath}"]
    }
  }
}
\`\`\`

Replace \`/absolute/path/to/\` with the actual absolute path to your project directory.

### 3. Restart Claude Desktop

Close and reopen Claude Desktop to load the new MCP server.

### 4. Test the Integration

In Claude Code, you can now use the auto-generated tools. For example:

- \`list_products\` - List all products
- \`get_product\` - Get a specific product by ID
- \`create_product\` - Create a new product
- And more...

## Environment Variables

The MCP server supports optional environment variables:

- \`DATABASE_URL\` - Database connection string

**AI Provider Configuration (in priority order):**
1. **Generic configuration** (supports any provider):
   - \`SMRT_AI_PROVIDER\` - Provider name (e.g., 'openai', 'anthropic', 'claude-cli', 'gemini')
   - \`SMRT_AI_API_KEY\` - API key for the provider
   - \`SMRT_AI_MODEL\` - Model to use (optional)

2. **Provider-specific fallbacks**:
   - \`OPENAI_API_KEY\` - OpenAI API key (auto-detects provider as 'openai')
   - \`ANTHROPIC_API_KEY\` - Anthropic API key (auto-detects provider as 'anthropic')
   - \`CLAUDE_API_KEY\` + \`CLAUDE_MODEL\` - Claude CLI provider (defaults to 'sonnet')

**Examples:**
\`\`\`bash
# Using generic configuration (recommended)
export SMRT_AI_PROVIDER=claude-cli
export SMRT_AI_MODEL=sonnet

# Using provider-specific configuration
export CLAUDE_API_KEY=your-key
export CLAUDE_MODEL=sonnet

# Using OpenAI
export OPENAI_API_KEY=your-openai-key
\`\`\`

## Troubleshooting

### Server Not Appearing in Claude

1. Check that the path in \`claude_desktop_config.json\` is absolute
2. Verify the server file exists at the specified path
3. Check Claude Desktop logs for errors

### Tools Not Working

1. Ensure your database is accessible (if using one)
2. Check that SMRT objects are properly decorated with \`@smrt()\`
3. Look for errors in the MCP server output

### Debug Mode

To enable debug logging, set the \`DEBUG\` constant to \`true\` in the generated server file.

## Generated Tools

The following tools are automatically generated from your SMRT objects:

- **CRUD Operations**: \`list_\`, \`get_\`, \`create_\`, \`update_\`, \`delete_\` for each object type
- **Custom Actions**: Any custom methods included in the \`@smrt()\` decorator configuration

See the SMRT object definitions for the complete list of available tools and their parameters.
`;
}
