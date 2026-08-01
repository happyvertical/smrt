/**
 * MCP (Model Context Protocol) server generator for smrt objects
 *
 * Exposes smrt objects as AI tools for Claude, GPT, and other AI models
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SmrtCollection } from '../collection';
import type { PublicJsonOptions, SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import type { RegisteredClass } from '../registry/types.js';
import type { FieldDefinition, MethodDefinition } from '../scanner/types.js';
import {
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  type CustomActionFailure,
  type CustomActionMetadata,
  customActionParameterInputName,
  normalizeCustomActionFailure,
  resolveCustomActionMetadata,
  SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY,
} from './custom-action.js';
import {
  generateClaudeConfig,
  generateMCPDocumentation,
  generateMCPScript,
  generateRuntimeBootstrap,
  type RuntimeOptions,
} from './mcp-runtime-template.js';
import { runWithTenantGate } from './tenant-gate.js';

/**
 * A JSON Schema fragment for an MCP tool input property. The shape varies by
 * field kind (string/number/object/…), so values are `unknown`; this is only
 * ever serialized into the generated tool definitions, never read back.
 */
type McpJsonSchema = Record<string, unknown>;

/**
 * Runtime tool-call arguments. They arrive as untyped JSON from the MCP client,
 * so individual keys are narrowed (`as`) at each action's boundary.
 */
type ToolArgs = Record<string, unknown>;

/**
 * A method resolved dynamically (by action name) from an object/collection
 * instance and invoked with the parsed tool-call arguments. Narrowed to this
 * type at the call boundary after a `typeof === 'function'` guard.
 */
type InstanceCallable = (...args: unknown[]) => unknown;

export interface MCPConfig {
  name?: string;
  version?: string;
  description?: string;
  server?: {
    name: string;
    version: string;
  };
}

export interface MCPContext {
  db?: unknown;
  ai?: unknown;
  user?: {
    id: string;
    roles?: string[];
  };
  /** Resolved permission slugs held by the caller. */
  permissions?: Iterable<string>;
  /**
   * Tenant the calling principal is scoped to (#1554). When set, tenant-scoped
   * tools run inside this tenant's context. Hosts that authenticate a principal
   * (e.g. `@happyvertical/smrt-app-mcp`) should derive it from the principal —
   * the MCP analogue of the SvelteKit auth hook setting `locals.tenantId`.
   */
  tenantId?: string;
  /**
   * Explicit operator opt-in to cross-tenant access for tenant-scoped tools
   * (#1554). Only set for trusted operator/admin callers. Without a `tenantId`
   * or this flag, tenant-scoped tool calls fail closed when tenancy is enabled.
   */
  allowCrossTenant?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, McpJsonSchema>;
    required?: string[];
  };
}

export interface MCPRequest {
  method: string;
  params: {
    name: string;
    arguments: ToolArgs;
  };
}

export interface MCPResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

class CustomActionFailureError extends Error {
  constructor(readonly failure: CustomActionFailure) {
    super(failure.message);
    this.name = 'CustomActionFailureError';
  }
}

/**
 * MCP tool identifiers are lowercase for stable protocol vocabulary, while
 * JavaScript method names retain their declared casing. Resolve a tool suffix
 * back to the registry's canonical method name before inspecting metadata or
 * invoking it.
 */
function resolveCustomActionMethod(
  methods: Map<string, MethodDefinition>,
  toolAction: string,
): [methodName: string, method: MethodDefinition | undefined] {
  const direct = methods.get(toolAction);
  if (direct) return [toolAction, direct];
  for (const [methodName, method] of methods) {
    if (methodName.toLowerCase() === toolAction.toLowerCase()) {
      return [methodName, method];
    }
  }
  return [toolAction, undefined];
}

/**
 * Generate MCP server from smrt objects
 */
export class MCPGenerator {
  private config: MCPConfig;
  private context: MCPContext;
  private collections = new Map<string, SmrtCollection<SmrtObject>>();

  constructor(config: MCPConfig = {}, context: MCPContext = {}) {
    this.config = {
      name: 'smrt-mcp-server',
      version: '1.0.0',
      description: 'Auto-generated MCP server from smrt objects',
      server: {
        name: 'smrt-mcp',
        version: '1.0.0',
      },
      ...config,
    };
    this.context = context;
  }

  /**
   * Get server name
   */
  get name(): string | undefined {
    return this.config.name;
  }

  /**
   * Get server version
   */
  get version(): string | undefined {
    return this.config.version;
  }

  /**
   * Generate all available tools from registered objects
   */
  async generateTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const registeredClasses = ObjectRegistry.getAllClasses();

    for (const [key, classInfo] of registeredClasses) {
      // Issue #951: Use simple name for tool naming, map key for registry lookups
      const simpleName = classInfo.name || key;
      const config = ObjectRegistry.getConfig(simpleName);
      const mcpConfig = config.mcp;

      // `mcp: false` disables MCP generation entirely for the class. Without
      // this gate an `include` list still leaked custom-method tools (the
      // custom-method branch historically only honored `include` when it
      // listed custom methods), so `false` is the only fully fail-closed
      // switch. Mirrors rest.ts's `apiConfig === false` short-circuit
      // (#1540 / #1546).
      if (mcpConfig === false) {
        continue;
      }

      // Handle boolean vs object config
      const excluded: string[] =
        typeof mcpConfig === 'object' && mcpConfig?.exclude
          ? mcpConfig.exclude
          : [];
      const included: string[] | undefined =
        typeof mcpConfig === 'object' ? mcpConfig?.include : undefined;

      const shouldInclude = (endpoint: string) => {
        if (included && !included.includes(endpoint)) return false;
        if (excluded.includes(endpoint)) return false;
        return true;
      };

      const objectTools = await this.generateObjectTools(
        simpleName,
        shouldInclude,
      );
      tools.push(...objectTools);
    }

    return tools;
  }

  /**
   * Generate tools for a specific object
   */
  private async generateObjectTools(
    objectName: string,
    shouldInclude: (endpoint: string) => boolean,
  ): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const fields = ObjectRegistry.getFields(objectName);
    const lowerName = objectName.toLowerCase();
    const classInfo = ObjectRegistry.getClass(objectName);

    // LIST tool
    if (shouldInclude('list')) {
      tools.push({
        name: `${lowerName}_list`,
        description: `List ${objectName} objects with optional filtering`,
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              description: 'Maximum number of items to return',
              default: 50,
              minimum: 1,
              maximum: 1000,
            },
            offset: {
              type: 'integer',
              description: 'Number of items to skip',
              default: 0,
              minimum: 0,
            },
            orderBy: {
              type: 'string',
              description: 'Field to order by (e.g., "created_at DESC")',
            },
            where: {
              type: 'object',
              description: 'Filter conditions as key-value pairs',
              additionalProperties: true,
            },
          },
        },
      });
    }

    // GET tool
    if (shouldInclude('get')) {
      tools.push({
        name: `${lowerName}_get`,
        description: `Get a specific ${objectName} by ID or slug`,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier of the object',
            },
            slug: {
              type: 'string',
              description: 'URL-friendly identifier of the object',
            },
          },
          required: ['id'],
        },
      });
    }

    // CREATE tool
    if (shouldInclude('create')) {
      const properties: Record<string, McpJsonSchema> = {};
      const required: string[] = [];

      for (const [fieldName, field] of fields) {
        properties[fieldName] = this.fieldToMCPSchema(field);
        if (field._meta?.required) {
          required.push(fieldName);
        }
      }

      tools.push({
        name: `${lowerName}_create`,
        description: `Create a new ${objectName}`,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
      });
    }

    // UPDATE tool
    if (shouldInclude('update')) {
      const properties: Record<string, McpJsonSchema> = {
        id: {
          type: 'string',
          description: 'ID of the object to update',
        },
      };

      for (const [fieldName, field] of fields) {
        properties[fieldName] = this.fieldToMCPSchema(field);
      }

      tools.push({
        name: `${lowerName}_update`,
        description: `Update an existing ${objectName}`,
        inputSchema: {
          type: 'object',
          properties,
          required: ['id'],
        },
      });
    }

    // DELETE tool
    if (shouldInclude('delete')) {
      tools.push({
        name: `${lowerName}_delete`,
        description: `Delete a ${objectName} by ID`,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID of the object to delete',
            },
          },
          required: ['id'],
        },
      });
    }

    // CUSTOM METHODS - discover from manifest and show by default
    if (classInfo) {
      const config = ObjectRegistry.getConfig(objectName);
      const mcpConfig = config.mcp;
      const included: string[] | undefined =
        typeof mcpConfig === 'object' ? mcpConfig?.include : undefined;
      const excluded: string[] =
        typeof mcpConfig === 'object' && mcpConfig?.exclude
          ? mcpConfig.exclude
          : [];

      // When an `include` list is present it is the COMPLETE allowlist for
      // this surface: a custom (non-CRUD) method is exposed ONLY if its name
      // appears in `include`. Without an include list we keep the historical
      // default of auto-exposing every public method. This closes the leak
      // where `mcp: { include: ['list', 'get'] }` still emitted custom-method
      // tools like `payment_recordpayment` because `include` only gated CRUD
      // verbs (#1540 / #1390).
      const crudOperations = ['list', 'get', 'create', 'update', 'delete'];
      const customMethodsInInclude =
        included?.filter((item) => !crudOperations.includes(item)) || [];
      // An include list (even one naming only CRUD verbs) switches custom
      // methods into strict allowlist mode.
      const hasIncludeList = included !== undefined;

      // Try to discover methods from manifest (including inherited methods)
      const methods = await ObjectRegistry.getAllMethods(objectName);
      const methodNames = new Set(Array.from(methods.keys()));

      // Strict mode: an include list is present, so only the custom methods it
      // names are generated (may be none, e.g. include: ['list', 'get']).
      if (hasIncludeList) {
        for (const methodName of customMethodsInInclude) {
          // Skip if explicitly excluded
          if (excluded.includes(methodName)) continue;

          // Check if method exists (in manifest or on class prototype)
          const existsInManifest = methodNames.has(methodName);
          const existsOnClass = this.validateCustomMethod(
            classInfo.constructor,
            methodName,
          );

          if (!existsInManifest && !existsOnClass) {
            // Warn about missing methods
            console.warn(
              `Warning: Custom action '${methodName}' specified in MCP config for ${objectName}, but method ${methodName}() not found on class`,
            );
            continue;
          }

          // A non-public method must never be exposed as a tool, even when it
          // is explicitly named in `include`. This keeps strict-include mode
          // consistent with the non-strict path below, which gates on
          // `methodDef.isPublic`. Listing a private method in `include` is a
          // config mistake, not an override of method visibility (#1540).
          //
          // The scanner strips private/protected methods from the manifest, so
          // when a non-public method is named in `include` it is absent from
          // `methods` and is only resolvable via validateCustomMethod() on the
          // runtime prototype (TS access modifiers are erased at runtime). Such
          // a method must NOT be emitted. We still allow methods that are
          // present on the class but legitimately absent from the manifest
          // (e.g. inline/dynamically registered classes), so the guard fires
          // only when there is a public manifest entry to anchor on OR the
          // method exists solely as a stripped (non-public) manifest method.
          const methodDef = methods.get(methodName);
          if (methodDef && !methodDef.isPublic) continue;

          tools.push(
            this.buildCustomActionTool(
              objectName,
              lowerName,
              methodName,
              methodDef,
              this.hasCollectionReceiver(classInfo),
            ),
          );
        }
      } else {
        // No custom methods in include = show all discovered methods by default
        for (const [methodName, methodDef] of methods) {
          // Skip if not public (private/protected methods shouldn't be in MCP)
          if (!methodDef.isPublic) continue;

          // Always respect exclude list
          if (excluded.includes(methodName)) continue;

          tools.push(
            this.buildCustomActionTool(
              objectName,
              lowerName,
              methodName,
              methodDef,
              this.hasCollectionReceiver(classInfo),
            ),
          );
        }
      }
    }

    return tools;
  }

  private buildCustomActionTool(
    objectName: string,
    lowerName: string,
    methodName: string,
    methodDef?: MethodDefinition,
    collectionReceiver = false,
  ): MCPTool {
    const metadata = this.resolveCustomActionMetadata(
      objectName,
      methodName,
      methodDef,
      collectionReceiver,
    );
    return {
      name: `${lowerName}_${methodName}`.toLowerCase(),
      description: `Execute ${methodName} action on ${objectName}`,
      inputSchema: buildCustomActionInputSchema(
        metadata,
      ) as MCPTool['inputSchema'],
    };
  }

  private resolveCustomActionMetadata(
    objectName: string,
    action: string,
    method?: MethodDefinition,
    collectionReceiver = false,
  ): CustomActionMetadata {
    return resolveCustomActionMetadata({
      actionName: action,
      method,
      apiConfig: ObjectRegistry.getConfig(objectName).api,
      ...(collectionReceiver ? { defaultScope: 'collection' } : {}),
    });
  }

  private hasCollectionReceiver(classInfo?: RegisteredClass): boolean {
    return (
      !!classInfo && classInfo.constructor.prototype instanceof SmrtCollection
    );
  }

  /**
   * Validate that a custom method exists on a class
   */
  private validateCustomMethod(
    classConstructor: typeof SmrtObject,
    methodName: string,
  ): boolean {
    try {
      // Check if method exists on the prototype
      const prototype = classConstructor.prototype;

      // Check if the method exists and is a function. Dynamic name lookup, so
      // index through a record view of the prototype/constructor.
      if (
        typeof (prototype as unknown as Record<string, unknown>)[methodName] ===
        'function'
      ) {
        return true;
      }

      // Also check static methods
      if (
        typeof (classConstructor as unknown as Record<string, unknown>)[
          methodName
        ] === 'function'
      ) {
        return true;
      }

      return false;
    } catch (error) {
      console.warn(
        `Error validating method ${methodName} on class ${classConstructor.name}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Convert field definition to MCP schema
   */
  private fieldToMCPSchema(field: FieldDefinition): McpJsonSchema {
    const schema: McpJsonSchema = {
      description: field._meta?.description || `${field.type} field`,
    };

    switch (field.type) {
      case 'text':
        schema.type = 'string';
        if (field._meta?.maxLength) schema.maxLength = field._meta.maxLength;
        if (field._meta?.minLength) schema.minLength = field._meta.minLength;
        break;
      case 'integer':
        schema.type = 'integer';
        if (field._meta?.min !== undefined) schema.minimum = field._meta.min;
        if (field._meta?.max !== undefined) schema.maximum = field._meta.max;
        break;
      case 'decimal':
        schema.type = 'number';
        if (field._meta?.min !== undefined) schema.minimum = field._meta.min;
        if (field._meta?.max !== undefined) schema.maximum = field._meta.max;
        break;
      case 'boolean':
        schema.type = 'boolean';
        break;
      case 'datetime':
        schema.type = 'string';
        schema.format = 'date-time';
        break;
      case 'json':
        schema.type = 'object';
        break;
      case 'foreignKey':
        schema.type = 'string';
        // Lockstep with tool-schema.ts fieldTypeToJsonSchema: the generic
        // relation hint is a fallback — an authored description wins (#2046).
        if (!field._meta?.description) {
          schema.description = `ID of related ${field.related || 'object'}`;
        }
        break;
      default:
        schema.type = 'string';
    }

    if (field._meta?.default !== undefined) {
      schema.default = field._meta.default;
    }

    return schema;
  }

  /**
   * Handle MCP tool calls
   */
  async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      // Check if tool exists
      const availableTools = await this.generateTools();
      const toolExists = availableTools.some((t) => t.name === name);

      if (!toolExists) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Parse tool name: `objectname_action`. Split on the FIRST underscore
      // only — a custom method name can itself contain underscores (e.g.
      // `record_payment` → tool `invoice_record_payment`). A naive
      // `name.split('_')` would take `action` as just `record` and mis-route
      // the call. The emitted stdio servers switch on the full tool name, so
      // splitting greedily here also kept the in-process path divergent (#1378).
      const firstUnderscore = name.indexOf('_');
      const objectName =
        firstUnderscore === -1 ? '' : name.slice(0, firstUnderscore);
      const action =
        firstUnderscore === -1 ? '' : name.slice(firstUnderscore + 1);

      if (!objectName || !action) {
        throw new Error(`Invalid tool name format: ${name}`);
      }

      // Find the registered class (case-insensitive)
      const registeredClasses = ObjectRegistry.getAllClasses();
      let classInfo = null;
      let actualObjectName = '';

      for (const [_key, info] of registeredClasses) {
        // Issue #951: Match by simple name, not the qualified map key
        const simpleName = info.name || _key;
        if (simpleName.toLowerCase() === objectName.toLowerCase()) {
          classInfo = info;
          actualObjectName = simpleName;
          break;
        }
      }

      if (!classInfo) {
        throw new Error(`Object type '${objectName}' not found`);
      }

      // Get or create collection
      const collection = await this.getCollection(actualObjectName, classInfo);

      // Execute the action
      const result = await this.executeAction(
        collection,
        action,
        args,
        actualObjectName,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof CustomActionFailureError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: error.failure }),
            },
          ],
          isError: true,
          _meta: {
            [SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY]: error.failure,
          },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  /**
   * Get or create collection for an object
   */
  private async getCollection(
    objectName: string,
    classInfo: RegisteredClass,
  ): Promise<SmrtCollection<SmrtObject>> {
    if (!this.collections.has(objectName)) {
      // Ensure we have a valid collection constructor
      if (
        !classInfo.collectionConstructor ||
        typeof classInfo.collectionConstructor !== 'function'
      ) {
        throw new Error(
          `No valid collection constructor found for ${objectName}`,
        );
      }

      const collection = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db: this.context.db,
      });

      // Verify the collection is actually a SmrtCollection instance
      if (!(collection instanceof SmrtCollection)) {
        throw new Error(
          `Collection for ${objectName} must extend SmrtCollection`,
        );
      }

      // Initialize the collection (database setup, etc.)
      await collection.initialize();

      this.collections.set(objectName, collection);
    }
    const collection = this.collections.get(objectName);
    if (!collection) {
      throw new Error(`Collection for ${objectName} not found`);
    }
    return collection;
  }

  /**
   * Serialize a tool-response payload, excluding sensitive fields (#1540).
   * Recurses through arrays and plain objects so a SmrtObject nested inside a
   * custom-action result (e.g. `{ item }`) is also stripped — `JSON.stringify`
   * would otherwise call its `toJSON()`. Non-plain instances (Date, etc.) and
   * primitives pass through unchanged; a cycle guard prevents infinite loops.
   */
  private toPublicData(
    value: unknown,
    seen: WeakSet<object> = new WeakSet(),
    options: PublicJsonOptions = this.getPublicJsonOptions(),
  ): unknown {
    if (value === null || typeof value !== 'object') return value;
    const publicSource = value as {
      toPublicJSON?: (options?: PublicJsonOptions) => unknown;
    };
    if (typeof publicSource.toPublicJSON === 'function') {
      return publicSource.toPublicJSON(options);
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return value;
      seen.add(value);
      return value.map((entry) => this.toPublicData(entry, seen, options));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = this.toPublicData(entry, seen, options);
    }
    return out;
  }

  private getPublicJsonOptions(): PublicJsonOptions {
    return { permissions: this.context.permissions };
  }

  /**
   * Mass-assignment guard (#1540): strip framework/server-managed and
   * `@field({ readonly: true })` fields from a create/update body, and — when an
   * `@smrt({ api: { writable: [...] } })` allowlist is set — intersect with it.
   */
  private applyWritablePolicy(
    objectName: string | undefined,
    data: unknown,
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const serverManaged = new Set([
      'id',
      'tenantId',
      'tenant_id',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);

    const readonly = new Set<string>();
    let writable: string[] | null = null;

    if (objectName) {
      const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
      if (
        apiConfig &&
        typeof apiConfig === 'object' &&
        Array.isArray((apiConfig as { writable?: unknown }).writable)
      ) {
        writable = (apiConfig as { writable: string[] }).writable;
      }

      for (const [name, def] of ObjectRegistry.getFields(objectName)) {
        if (def && (def.readonly === true || def._meta?.readonly === true)) {
          readonly.add(name);
        }
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (serverManaged.has(key)) continue;
      if (readonly.has(key)) continue;
      if (writable && !writable.includes(key)) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Execute action on collection
   */
  /**
   * Fail-closed authorization for tool calls (#1540). Mutating tools
   * (create/update/delete + custom actions) require an authenticated principal
   * (`context.user`) unless the object opts out via `@smrt({ api: { public } })`.
   * Reads are allowed when `public` is `true` or `'read'`.
   */
  private requireToolAuth(
    objectName: string | undefined,
    mutating: boolean,
  ): void {
    const apiConfig = objectName
      ? ObjectRegistry.getConfig(objectName)?.api
      : undefined;
    const publicAccess =
      apiConfig && typeof apiConfig === 'object'
        ? (apiConfig as { public?: boolean | 'read' }).public
        : undefined;

    if (publicAccess === true) return;
    if (publicAccess === 'read' && !mutating) return;
    if (!this.context.user) {
      throw new Error('Authentication required');
    }
  }

  private async executeAction(
    collection: SmrtCollection<SmrtObject>,
    action: string,
    args: ToolArgs,
    objectName?: string,
  ): Promise<unknown> {
    const mutating = action !== 'list' && action !== 'get';
    this.requireToolAuth(objectName, mutating);

    // Fail-closed tenant context (#1554). For tenant-scoped objects, establish
    // the context from the principal's tenant (or an explicit cross-tenant
    // opt-in); without either, this throws when tenancy is enabled rather than
    // letting an optional-scoped read range across all tenants. Tenant-scoping
    // is resolved inside tenancy by class name so it matches the interceptor.
    return runWithTenantGate(
      {
        className: objectName,
        tenantId: this.context.tenantId,
        allowCrossTenant: this.context.allowCrossTenant,
        surface: 'MCP',
      },
      () => this.runAction(collection, action, args, objectName),
    );
  }

  /**
   * Derive the set of tenant-scoped object names (lowercased simple names) from
   * a generated tool list, for the emitted runtime template's tenant gate
   * (#1554). Tool names are `objectname_action`.
   *
   * Detection uses ONLY tenancy's `isTenantScopedClass` (the authoritative
   * source the interceptor uses; covers `@TenantScoped`), consulted via an
   * optional dynamic import. We deliberately do NOT fall back to core's
   * `ObjectRegistry.isTenantScoped`: a `@smrt({ tenantScoped })` model can exist
   * in an app that has NOT installed `@happyvertical/smrt-tenancy`, and emitting
   * the static `import { runTenantScopedEntryPoint } from '@happyvertical/smrt-tenancy'`
   * gate for it would crash the generated server at import time. When tenancy is
   * absent there is also nothing to enforce, so emitting no gate is correct.
   */
  private async tenantScopedObjectNames(tools: MCPTool[]): Promise<string[]> {
    let isTenantScopedClass: ((name: string) => boolean) | undefined;
    try {
      // Held in a variable so neither TypeScript's declaration emit (TS2307 —
      // core deliberately does not depend on tenancy) nor the bundler tries to
      // statically resolve this optional sibling package. Same pattern as
      // `tenant-gate.ts` / `embeddings/provider.ts`.
      const tenancySpecifier = '@happyvertical/smrt-tenancy';
      const tenancy = (await import(/* @vite-ignore */ tenancySpecifier)) as {
        isTenantScopedClass?: (name: string) => boolean;
      };
      isTenantScopedClass = tenancy.isTenantScopedClass;
    } catch {
      isTenantScopedClass = undefined;
    }

    // No tenancy package installed → no gate can run, emit none.
    if (typeof isTenantScopedClass !== 'function') return [];

    const scoped = new Set<string>();
    for (const tool of tools) {
      const [objectName] = tool.name.split('_');
      if (!objectName) continue;
      // Resolve the registered simple name (case-insensitive) and test scoping.
      for (const [key, info] of ObjectRegistry.getAllClasses()) {
        const simpleName = info.name || key;
        if (simpleName.toLowerCase() === objectName.toLowerCase()) {
          if (isTenantScopedClass(simpleName)) {
            scoped.add(simpleName.toLowerCase());
          }
          break;
        }
      }
    }
    return Array.from(scoped);
  }

  /**
   * Execute a resolved MCP action (CRUD or custom) against a collection. Always
   * invoked inside the tenant gate established by {@link executeAction}.
   */
  private async runAction(
    collection: SmrtCollection<SmrtObject>,
    action: string,
    args: ToolArgs,
    objectName?: string,
  ): Promise<unknown> {
    switch (action) {
      case 'list': {
        // Args arrive as untyped JSON; narrow each query field at this
        // boundary. `where`/`orderBy` are passed through to the collection's
        // typed query API.
        const listOptions: Parameters<typeof collection.list>[0] = {
          limit: Math.min((args.limit as number | undefined) || 50, 1000),
          offset: (args.offset as number | undefined) || 0,
        };

        if (args.where) {
          listOptions.where = args.where as (typeof listOptions)['where'];
        }

        if (args.orderBy) {
          listOptions.orderBy = args.orderBy as string | string[];
        }

        const results = await collection.list(listOptions);
        const total = await collection.count({
          where: (args.where as (typeof listOptions)['where']) || {},
        });

        return {
          data: results.map((result) => this.toPublicData(result)),
          meta: {
            total,
            limit: listOptions.limit,
            offset: listOptions.offset,
            count: results.length,
          },
        };
      }

      case 'get': {
        if (!args.id && !args.slug) {
          throw new Error('Either id or slug is required');
        }

        const filter = (args.id ? args.id : args.slug) as string;
        const item = await collection.get(filter);

        if (!item) {
          throw new Error('Object not found');
        }

        return this.toPublicData(item);
      }

      case 'create': {
        // Mass-assignment guard (#1540): only writable fields from the caller.
        const createData: Record<string, unknown> = this.applyWritablePolicy(
          objectName,
          args,
        );
        // Server-set ownership context (not caller-controlled).
        if (this.context.user) {
          createData.created_by = this.context.user.id;
          createData.owner_id = this.context.user.id;
        }

        // The writable-policy output is a dynamically-shaped record of caller
        // data; cast to the collection's create input at this boundary.
        const newItem = await collection.create(
          createData as Parameters<typeof collection.create>[0],
        );
        await newItem.save();

        return this.toPublicData(newItem);
      }

      case 'update': {
        const id = args.id as string | undefined;
        if (!id) {
          throw new Error('ID is required for update');
        }

        const existing = await collection.get(id);
        if (!existing) {
          throw new Error('Object not found');
        }

        // Mass-assignment guard (#1540): strip server-managed/read-only keys
        // (incl. `id`) before applying caller-supplied updates.
        const updateData = this.applyWritablePolicy(objectName, args);
        Object.assign(existing, updateData);

        // Add user context. `updated_by` is a server-set audit column, not a
        // declared model field, so assign it through a record view.
        if (this.context.user) {
          (existing as unknown as Record<string, unknown>).updated_by =
            this.context.user.id;
        }

        await existing.save();

        return this.toPublicData(existing);
      }

      case 'delete': {
        if (!args.id) {
          throw new Error('ID is required for delete');
        }

        const toDelete = await collection.get(args.id as string);
        if (!toDelete) {
          throw new Error('Object not found');
        }

        await toDelete.delete();

        return { success: true, message: 'Object deleted successfully' };
      }

      default: {
        // Handle custom actions. The method may return a SmrtObject (or array),
        // so serialize through toPublicData to strip sensitive fields (#1540).
        const result = await this.executeCustomAction(
          collection,
          action,
          args,
          objectName,
        );
        return this.toPublicData(result);
      }
    }
  }

  /**
   * Execute a custom action on a collection/object
   */
  private async executeCustomAction(
    collection: SmrtCollection<SmrtObject>,
    action: string,
    args: ToolArgs,
    objectName?: string,
  ): Promise<unknown> {
    const id = args.id;
    const [methodName, methodDef] = objectName
      ? resolveCustomActionMethod(
          await ObjectRegistry.getAllMethods(objectName),
          action,
        )
      : [action, undefined];
    const metadata = this.resolveCustomActionMetadata(
      objectName ?? '',
      methodName,
      methodDef,
      objectName
        ? this.hasCollectionReceiver(ObjectRegistry.getClass(objectName))
        : false,
    );
    const methodArgs = buildCustomActionInvocationArgs(metadata, args);

    try {
      if (methodDef && metadata.idRequired && !id) {
        throw new Error(`ID is required for custom action '${action}'`);
      }
      if (!metadata.idRequired && id && methodDef) {
        throw new Error(
          `Custom action '${action}' is collection-scoped and does not accept an ID`,
        );
      }

      // If an ID is provided, get the specific object and call the method on it
      if (id) {
        const object = await collection.get(id as string);
        if (!object) {
          throw new Error('Object not found');
        }

        // Custom action names are resolved dynamically, so index the instance
        // through a record view and narrow the value to a callable after the
        // `typeof === 'function'` guard.
        const objectWithMethods = object as unknown as Record<string, unknown>;
        const objectMethod = objectWithMethods[methodName];
        if (typeof objectMethod === 'function') {
          // `.call(object, …)` preserves the receiver binding of the original
          // member call (`object[action](…)`) — the method relies on `this`.
          const result = await (objectMethod as InstanceCallable).call(
            object,
            ...methodArgs,
          );
          const failure = normalizeCustomActionFailure(result);
          if (failure) throw new CustomActionFailureError(failure);
          return result;
        } else {
          throw new Error(
            `Method '${methodName}' not found on object instance`,
          );
        }
      } else if (metadata.isStatic && objectName) {
        const classInfo = ObjectRegistry.getClass(objectName);
        const classMethod = (
          classInfo?.constructor as unknown as
            | Record<string, unknown>
            | undefined
        )?.[methodName];
        if (typeof classMethod !== 'function') {
          throw new Error(
            `Static method '${methodName}' not found on ${objectName}`,
          );
        }
        const result = await (classMethod as InstanceCallable).call(
          classInfo?.constructor,
          ...methodArgs,
        );
        const failure = normalizeCustomActionFailure(result);
        if (failure) throw new CustomActionFailureError(failure);
        return result;
      } else {
        // No ID provided, try to call the method on the collection
        const collectionMethod = (
          collection as unknown as Record<string, unknown>
        )[methodName];
        if (typeof collectionMethod === 'function') {
          // `.call(collection, …)` preserves the receiver binding of the
          // original member call (`collection[action](…)`).
          const result = await (collectionMethod as InstanceCallable).call(
            collection,
            ...methodArgs,
          );
          const failure = normalizeCustomActionFailure(result);
          if (failure) throw new CustomActionFailureError(failure);
          return result;
        } else {
          throw new Error(
            `Method '${methodName}' not found on collection. For object-specific actions, provide an 'id' parameter.`,
          );
        }
      }
    } catch (error) {
      if (error instanceof CustomActionFailureError) throw error;
      throw new Error(
        `Failed to execute custom action '${action}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Generate MCP server info
   */
  getServerInfo() {
    return {
      name: this.config.server?.name,
      version: this.config.server?.version,
      description: this.config.description,
    };
  }

  /**
   * Generate complete MCP server with stdio transport
   *
   * Creates a runnable Node.js script that exposes SMRT objects as MCP tools.
   * The generated server includes:
   * - Stdio transport integration
   * - Tool registration from ObjectRegistry
   * - Error handling and logging
   * - Graceful shutdown
   *
   * @param options - Server generation options
   * @returns Promise that resolves when all files are written
   *
   * @example
   * ```typescript
   * const generator = new MCPGenerator({
   *   name: 'my-app',
   *   version: '1.0.0'
   * });
   *
   * await generator.generateServer({
   *   outputPath: '.smrt/mcp-server/index.js',
   *   serverName: 'my-app-mcp',
   *   debug: true
   * });
   * ```
   */
  async generateServer(
    options: {
      /** Path to output server file (relative or absolute) */
      outputPath?: string;

      /** Server name for configuration */
      serverName?: string;

      /** Server version */
      serverVersion?: string;

      /** Enable debug logging */
      debug?: boolean;

      /** Generate Claude Desktop configuration example */
      generateClaudeConfigFile?: boolean;

      /** Generate README documentation */
      generateReadme?: boolean;

      /** Generate modular directory structure (tools/, handlers/, config.ts) */
      modular?: boolean;
    } = {},
  ): Promise<void> {
    const {
      outputPath = '.smrt/mcp-server/index.js',
      serverName = this.config.name || 'smrt-mcp-server',
      serverVersion = this.config.version || '1.0.0',
      debug = false,
      generateClaudeConfigFile = false,
      generateReadme = false,
      modular = false,
    } = options;

    // Resolve output path
    const resolvedPath = resolve(process.cwd(), outputPath);
    const outputDir = dirname(resolvedPath);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    if (modular) {
      // Generate modular structure: tools/, handlers/, config.ts, index.js
      await this.generateModularServer(
        outputDir,
        serverName,
        serverVersion,
        debug,
      );
    } else {
      // Generate single-file server with static tools
      const tools = await this.generateTools();

      const runtimeOptions: RuntimeOptions = {
        name: serverName,
        version: serverVersion,
        description: this.config.description,
        config: this.config,
        context: this.context,
        debug,
        tools,
        customActions: await this.runtimeCustomActions(tools),
        tenantScopedObjects: await this.tenantScopedObjectNames(tools),
      };

      const serverCode = generateRuntimeBootstrap(runtimeOptions);

      // Write server file
      await writeFile(resolvedPath, serverCode, 'utf-8');
      console.log(`✅ Generated MCP server: ${resolvedPath}`);
    }

    // Generate Claude Desktop configuration example
    if (generateClaudeConfigFile) {
      const claudeConfig = generateClaudeConfig(serverName, resolvedPath);
      const claudeConfigPath = resolve(outputDir, 'claude-config.example.json');
      await writeFile(
        claudeConfigPath,
        JSON.stringify(claudeConfig, null, 2),
        'utf-8',
      );
      console.log(`✅ Generated Claude config example: ${claudeConfigPath}`);
    }

    // Generate README documentation
    if (generateReadme) {
      const readme = generateMCPDocumentation(serverName, outputPath);
      const readmePath = resolve(outputDir, 'MCP-README.md');
      await writeFile(readmePath, readme, 'utf-8');
      console.log(`✅ Generated MCP documentation: ${readmePath}`);
    }

    // Generate npm script suggestion
    const mcpScript = generateMCPScript(outputPath);
    console.log(`\n📝 Add this to your package.json scripts:`);
    console.log(`   "mcp": "${mcpScript}"\n`);
  }

  private async runtimeCustomActions(
    tools: MCPTool[],
  ): Promise<NonNullable<RuntimeOptions['customActions']>> {
    const metadata: NonNullable<RuntimeOptions['customActions']> = {};
    const crudActions = new Set(['list', 'get', 'create', 'update', 'delete']);
    const classes = ObjectRegistry.getAllClasses();

    for (const tool of tools) {
      const separator = tool.name.indexOf('_');
      if (separator === -1) continue;
      const objectPrefix = tool.name.slice(0, separator);
      const action = tool.name.slice(separator + 1);
      if (crudActions.has(action)) continue;
      const matched = Array.from(classes.entries()).find(
        ([key, info]) => (info.name || key).toLowerCase() === objectPrefix,
      );
      if (!matched) continue;
      const [key, classInfo] = matched;
      const objectName = classInfo.name || key;
      const [methodName, method] = resolveCustomActionMethod(
        await ObjectRegistry.getAllMethods(objectName),
        action,
      );
      const resolved = this.resolveCustomActionMetadata(
        objectName,
        methodName,
        method,
        this.hasCollectionReceiver(classInfo),
      );
      metadata[tool.name] = {
        scope: resolved.scope,
        isStatic: resolved.isStatic,
        methodName,
        ...(resolved.parameters
          ? {
              parameterNames: resolved.parameters.map(
                (parameter) => parameter.name,
              ),
              optionsParameter:
                resolved.parameters.length === 1 &&
                resolved.parameters[0]?.name === 'options',
            }
          : {}),
        legacyOptions: !resolved.parameters,
      };
    }
    return metadata;
  }

  /**
   * Generate modular MCP server structure
   *
   * Creates separate files for tools, handlers, configuration, and main entry point.
   * This makes the generated server easier to customize and extend.
   *
   * @param outputDir - Directory to generate files in
   * @param serverName - Server name
   * @param serverVersion - Server version
   * @param debug - Enable debug logging
   */
  private async generateModularServer(
    outputDir: string,
    serverName: string,
    serverVersion: string,
    debug: boolean,
  ): Promise<void> {
    // Create subdirectories
    const toolsDir = resolve(outputDir, 'tools');
    const handlersDir = resolve(outputDir, 'handlers');

    await mkdir(toolsDir, { recursive: true });
    await mkdir(handlersDir, { recursive: true });

    // Generate config.ts
    const configPath = resolve(outputDir, 'config.ts');
    const configCode = this.generateConfigFile(
      serverName,
      serverVersion,
      debug,
    );
    await writeFile(configPath, configCode, 'utf-8');
    console.log(`✅ Generated config: ${configPath}`);

    // Generate tools/index.ts with tool definitions
    const toolsPath = resolve(toolsDir, 'index.ts');
    const toolsCode = await this.generateToolsFile();
    await writeFile(toolsPath, toolsCode, 'utf-8');
    console.log(`✅ Generated tools: ${toolsPath}`);

    // Generate handlers/index.ts with tool call handlers
    const handlersPath = resolve(handlersDir, 'index.ts');
    const tenantScopedObjects = await this.tenantScopedObjectNames(
      await this.generateTools(),
    );
    const handlersCode = await this.generateHandlersFile(tenantScopedObjects);
    await writeFile(handlersPath, handlersCode, 'utf-8');
    console.log(`✅ Generated handlers: ${handlersPath}`);

    // Generate main index.js entry point
    const indexPath = resolve(outputDir, 'index.js');
    const indexCode = this.generateModularIndex();
    await writeFile(indexPath, indexCode, 'utf-8');
    console.log(`✅ Generated MCP server: ${indexPath}`);
  }

  /**
   * Generate configuration file for modular server
   */
  private generateConfigFile(
    serverName: string,
    serverVersion: string,
    debug: boolean,
  ): string {
    return `/**
 * MCP Server Configuration
 * Auto-generated by @happyvertical/smrt-core
 */

export const SERVER_NAME = ${JSON.stringify(serverName)};
export const SERVER_VERSION = ${JSON.stringify(serverVersion)};
export const SERVER_DESCRIPTION = ${JSON.stringify(this.config.description)};
export const DEBUG = ${debug};
`;
  }

  /**
   * Generate tools definitions file for modular server
   */
  private async generateToolsFile(): Promise<string> {
    const tools = await this.generateTools();

    return `/**
 * MCP Tools Definitions
 * Auto-generated from SMRT objects
 */

export const tools: Array<{
  name: string;
  description: string;
  inputSchema: any;
}> = ${JSON.stringify(tools, null, 2)};
`;
  }

  /**
   * Generate switch cases for tool execution
   */
  private async generateToolSwitchCases(
    indent: string = '    ',
  ): Promise<string> {
    const tools = await this.generateTools();

    const capitalize = (str: string) =>
      str.charAt(0).toUpperCase() + str.slice(1);

    const switchCases = (
      await Promise.all(
        tools.map(async (tool) => {
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
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const items = await collection.list({ where, limit, offset });
${indent}  const itemsPublic = items.map((item) => item.toPublicJSON(PUBLIC_JSON_OPTIONS));
${indent}  return { content: [{ type: 'text', text: JSON.stringify(itemsPublic) }] };
${indent}}`;

            case 'get':
              return `${indent}case '${tool.name}': {
${indent}  if (!args.id && !args.slug) {
${indent}    throw new Error('Either id or slug is required');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const filter = args.id || args.slug;
${indent}  const item = await collection.get(filter);

${indent}  if (!item) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  return { content: [{ type: 'text', text: JSON.stringify(item.toPublicJSON(PUBLIC_JSON_OPTIONS)) }] };
${indent}}`;

            case 'create':
              return `${indent}case '${tool.name}': {
${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const newItem = await collection.create(applyWritablePolicy('${capitalize(objectName)}', args));
${indent}  await newItem.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(newItem.toPublicJSON(PUBLIC_JSON_OPTIONS)) }] };
${indent}}`;

            case 'update':
              return `${indent}case '${tool.name}': {
${indent}  const { id, ...updateData } = args;
${indent}  if (!id) {
${indent}    throw new Error('ID is required for update');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const existing = await collection.get(id);
${indent}  if (!existing) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  Object.assign(existing, applyWritablePolicy('${capitalize(objectName)}', updateData));
${indent}  await existing.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(existing.toPublicJSON(PUBLIC_JSON_OPTIONS)) }] };
${indent}}`;

            case 'delete':
              return `${indent}case '${tool.name}': {
${indent}  if (!args.id) {
${indent}    throw new Error('ID is required for delete');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const toDelete = await collection.get(args.id);
${indent}  if (!toDelete) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  await toDelete.delete();

${indent}  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Object deleted successfully' }) }] };
${indent}}`;

            default: {
              // Custom actions use the same canonical receiver/argument contract
              // as the in-process and standalone MCP runtimes. In particular,
              // a route config cannot turn an instance method into a static one.
              const matched = Array.from(
                ObjectRegistry.getAllClasses().entries(),
              ).find(
                ([key, info]) =>
                  (info.name || key).toLowerCase() === objectName.toLowerCase(),
              );
              if (!matched) {
                throw new Error(
                  `Unable to resolve custom-action target for tool '${tool.name}'`,
                );
              }
              const [classKey, classInfo] = matched;
              const registeredName = classInfo.name || classKey;
              const [methodName, method] = resolveCustomActionMethod(
                await ObjectRegistry.getAllMethods(registeredName),
                action,
              );
              const metadata = this.resolveCustomActionMetadata(
                registeredName,
                methodName,
                method,
                this.hasCollectionReceiver(classInfo),
              );
              const methodArgs = !metadata.parameters
                ? 'Object.keys(options ?? {}).length > 0 ? options : directArgs'
                : metadata.parameters.length === 1 &&
                    metadata.parameters[0]?.name === 'options'
                  ? 'options'
                  : `[${metadata.parameters
                      .map(
                        (parameter) =>
                          `args[${JSON.stringify(
                            customActionParameterInputName(
                              metadata,
                              parameter.name,
                            ),
                          )}]`,
                      )
                      .join(', ')}]`;
              return `${indent}case '${tool.name}': {
${indent}  const { id, options, ...directArgs } = args;

${indent}  if (${JSON.stringify(metadata.scope)} === 'item' && !id) {
${indent}    throw new Error('ID is required for custom action ${action}');
${indent}  }
${indent}  if (${JSON.stringify(metadata.scope)} === 'collection' && id) {
${indent}    throw new Error('Custom action ${action} is collection-scoped and does not accept an ID');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection(${JSON.stringify(registeredName)}, {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const target = ${JSON.stringify(metadata.scope)} === 'item'
${indent}    ? await collection.get(id)
${indent}    : ${metadata.isStatic}
${indent}      ? ObjectRegistry.getClass(${JSON.stringify(registeredName)})?.constructor
${indent}      : collection;
${indent}  if (!target) {
${indent}    throw new Error(${JSON.stringify(
                metadata.scope === 'item'
                  ? 'Object not found'
                  : 'Custom action target not found',
              )});
${indent}  }

${indent}  const actionMethod = target[${JSON.stringify(methodName)}];
${indent}  if (typeof actionMethod !== 'function') {
${indent}    throw new Error('Method ${methodName} not found on custom action target');
${indent}  }

${indent}  const methodArgs = ${methodArgs.startsWith('[') ? methodArgs : `[${methodArgs}]`};
${indent}  const result = await actionMethod.call(target, ...methodArgs);
${indent}  const failure = normalizeCustomActionFailure(result);
${indent}  if (failure) {
${indent}    return {
${indent}      content: [{ type: 'text', text: JSON.stringify({ error: failure }) }],
${indent}      isError: true,
${indent}      _meta: { [SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY]: failure },
${indent}    };
${indent}  }

${indent}  return { content: [{ type: 'text', text: JSON.stringify(toPublicResult(result)) }] };
${indent}}`;
            }
          }
        }),
      )
    ).join('\n\n');

    return switchCases;
  }

  /**
   * Generate handlers file for modular server
   */
  private async generateHandlersFile(
    tenantScopedObjects: string[] = [],
  ): Promise<string> {
    const switchCases = await this.generateToolSwitchCases('        ');
    const tenantScopedSet = Array.from(
      new Set(tenantScopedObjects.map((n) => n.toLowerCase())),
    );
    const hasTenantScoped = tenantScopedSet.length > 0;

    return `/**
 * MCP Tool Call Handlers
 * Auto-generated from SMRT objects
 *
 * SECURITY (#1540): responses exclude @field({ sensitive }) fields and
 * create/update bodies are mass-assignment guarded. This handler has no
 * per-call authentication principal — the generated stdio MCP server's trust
 * boundary is the host process / MCP client. Run it only in a trusted context
 * or behind an authenticated gateway.
 *
 * SECURITY (#1554): tenant-scoped tools run inside a fail-closed tenant gate;
 * the tenant is taken from SMRT_MCP_TENANT_ID (this server has no auth
 * principal) and tenancy is enabled so the interceptor enforces filtering.
 */

import { ObjectRegistry, normalizeCustomActionFailure, SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY } from '@happyvertical/smrt-core';
${hasTenantScoped ? "import { enableTenancy, runTenantScopedEntryPoint } from '@happyvertical/smrt-tenancy';\n" : ''}${
  hasTenantScoped
    ? `
// Install the tenancy interceptor so tenant-scoped tools are filtered and the
// gate fail-closes when no tenant is supplied (#1554).
enableTenancy();
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
  const serverManaged = new Set<string>([
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
  for (const [key, value] of Object.entries(data as Record<string, any>)) {
    if (key.startsWith('_')) continue;
    if (serverManaged.has(key)) continue;
    if (readonly.has(key)) continue;
    if (writable && !writable.includes(key)) continue;
    result[key] = value;
  }
  return result;
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
  for (const [key, entry] of Object.entries(value as Record<string, any>)) {
    out[key] = toPublicResult(entry, seen);
  }
  return out;
}

/**
 * Handle tool call request
 */
export async function handleToolCall(
  name: string,
  arguments: any = {},
  aiConfig: any = {}
) {
  try {
    const args = arguments;

    const runToolBody = async () => {
      switch (name) {
${switchCases}

        default:
          throw new Error(\`Unknown tool: \${name}\`);
      }
    };
${
  hasTenantScoped
    ? `
    // Fail-closed tenant context for tenant-scoped tools (#1554).
    const [toolObject] = name.split('_');
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

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      content: [
        {
          type: 'text',
          text: \`Error executing tool \${name}: \${errorMessage}\`,
        },
      ],
      isError: true,
    };
  }
}
`;
  }

  /**
   * Generate modular index file (main entry point)
   */
  private generateModularIndex(): string {
    return `#!/usr/bin/env node
/**
 * Auto-generated MCP Server
 * Generated by @happyvertical/smrt-core MCPGenerator
 *
 * This server exposes SMRT objects as MCP tools for AI integration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { getAI } from '@happyvertical/ai';

import { SERVER_NAME, SERVER_VERSION, DEBUG } from './config.js';
import { tools } from './tools/index.js';
import { handleToolCall } from './handlers/index.js';

/**
 * Main server startup function
 */
async function main() {
  try {
    if (DEBUG) {
      console.error(\`[MCP] Starting server: \${SERVER_NAME} v\${SERVER_VERSION}\`);
      console.error(\`[MCP] Available tools:\`, tools.map(t => t.name).join(', '));
    }

    // Load configuration from environment and .smrt.config files
    const appConfig = await config.load();
    const aiConfig = appConfig?.ai || {};

    // Create MCP server
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register ListTools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (DEBUG) {
        console.error(\`[MCP] ListTools request received\`);
      }

      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Register CallTool handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      if (DEBUG) {
        console.error(\`[MCP] CallTool request: \${name}\`);
        console.error(\`[MCP] Arguments:\`, JSON.stringify(args, null, 2));
      }

      return await handleToolCall(name, args, aiConfig);
    });

    // Setup stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    if (DEBUG) {
      console.error(\`[MCP] Server connected and ready\`);
    }

    // Handle graceful shutdown
    const shutdown = async () => {
      if (DEBUG) {
        console.error(\`[MCP] Shutting down gracefully\`);
      }
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[MCP] Fatal error during server startup:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[MCP] Unhandled error:', error);
  process.exit(1);
});
`;
  }
}
