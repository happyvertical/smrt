import {
  buildCustomActionInputSchema,
  type CustomActionMetadata,
  type ToolEffect,
} from './custom-action.js';

/**
 * Transport-agnostic tool-descriptor builder (#1812, tracer).
 *
 * The single source of truth for turning a model's fields + exposed actions into
 * MCP-shaped tool descriptors (`{ name, description, inputSchema }`). This is the
 * shape both the Model Context Protocol AND Chrome's WebMCP
 * (`document.modelContext.registerTool`) consume — see
 * https://developer.chrome.com/docs/ai/webmcp.
 *
 * It is deliberately pure and free of `ObjectRegistry` / manifest coupling: it
 * takes a normalized {@link ToolFieldMeta}[] so BOTH callers can share it —
 *  - `MCPGenerator` (`src/generators/mcp.ts`) for the Node stdio server, and
 *  - the web-collections emitter (`src/vite-plugin/web-collections.ts`) for the
 *    browser client-data runtime's WebMCP descriptors.
 *
 * Keeping one implementation removes the field-mapping drift risk the
 * "three emission sites must agree" contract in web-collections.ts already warns
 * about. The `fieldTypeToJsonSchema` / per-action skeletons below are ported
 * verbatim from mcp.ts's `fieldToMCPSchema` + `generateObjectTools`, so wiring
 * mcp.ts to call this helper is a mechanical, behavior-preserving refactor.
 */

/**
 * A JSON Schema fragment. Values vary by field kind, so this is only ever
 * serialized into tool descriptors, never read back structurally.
 */
export type ToolJsonSchema = Record<string, unknown>;

/** The only JSON Schema dialect emitted by generated MCP and WebMCP tools. */
export const JSON_SCHEMA_2020_12 =
  'https://json-schema.org/draft/2020-12/schema';

/**
 * Bounds for generated schemas. Field metadata is authored input, so it must
 * not turn a tools/list response into an unbounded composition or validation
 * workload. These limits are deliberately far above normal SMRT objects while
 * still keeping schemas comfortably inside MCP transport budgets.
 */
export const MCP_SCHEMA_LIMITS = {
  maxDepth: 16,
  maxNodes: 2_048,
  maxSerializedBytes: 65_536,
} as const;

/**
 * Apply the draft-2020-12 dialect and reject schemas that violate MCP's
 * bounded-composition contract. Generated schemas only ever reference local
 * `$defs`; external refs are neither emitted nor followed.
 */
export function finalizeMcpJsonSchema(schema: ToolJsonSchema): ToolJsonSchema {
  const finalized = {
    ...schema,
    $schema: JSON_SCHEMA_2020_12,
  };
  assertMcpJsonSchemaSafety(finalized);
  return finalized;
}

/**
 * Validate the resource envelope of an emitted schema without resolving refs.
 * This is intentionally structural rather than a general JSON-Schema
 * evaluator: the server already owns every schema it emits, and this guard
 * exists to keep authored metadata from introducing hostile shape growth.
 */
export function assertMcpJsonSchemaSafety(schema: ToolJsonSchema): void {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number, key?: string): void => {
    nodes += 1;
    if (nodes > MCP_SCHEMA_LIMITS.maxNodes) {
      throw new Error(
        `MCP JSON Schema exceeds ${MCP_SCHEMA_LIMITS.maxNodes} nodes`,
      );
    }
    if (depth > MCP_SCHEMA_LIMITS.maxDepth) {
      throw new Error(
        `MCP JSON Schema exceeds ${MCP_SCHEMA_LIMITS.maxDepth} levels of depth`,
      );
    }
    if (key === '$ref') {
      if (
        typeof value !== 'string' ||
        !value.startsWith('#/$defs/') ||
        value.includes('://')
      ) {
        throw new Error(
          'MCP JSON Schema may only use local #/$defs/ references',
        );
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (ancestors.has(value)) {
      throw new Error('MCP JSON Schema must not contain cyclic values');
    }

    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, depth + 1, childKey);
      }
    }
    ancestors.delete(value);
  };

  visit(schema, 0);

  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error('MCP JSON Schema must be JSON-serializable');
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    MCP_SCHEMA_LIMITS.maxSerializedBytes
  ) {
    throw new Error(
      `MCP JSON Schema exceeds ${MCP_SCHEMA_LIMITS.maxSerializedBytes} serialized bytes`,
    );
  }
}

/**
 * Normalized field metadata — the intersection of what the runtime registry
 * (`FieldDefinition._meta`) and the build-time manifest (`WebFieldDefinition`)
 * can each supply. Callers flatten their own field source into this shape.
 */
export interface ToolFieldMeta {
  name: string;
  /** Field kind: text | integer | decimal | boolean | datetime | json | foreignKey | … */
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  /** Field values may explicitly be null in the runtime/manifest contract. */
  nullable?: boolean;
  /** For `foreignKey`: the related class name, for the generated description. */
  related?: string;
}

/** Storage contract for the synthetic primary identifier. */
export type ToolIdType = 'uuid' | 'text';

/** The CRUD verbs with dedicated input-schema skeletons; anything else is custom. */
const CRUD_ACTIONS = new Set(['list', 'get', 'create', 'update', 'delete']);

export interface ToolRouteDescriptor {
  /** HTTP method emitted for the route. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Whether the route targets one item or the whole collection. */
  scope: 'item' | 'collection';
  /** Route segments below the collection endpoint. Dynamic segments use `[x]`. */
  path: string[];
  /** Transport names rewritten by the tool schema (e.g. `actionId` → `id`). */
  parameterAliases?: Record<string, string>;
  /** The generated method accepts one `options` bag as its sole argument. */
  optionsBag?: boolean;
}

/** A single generated tool descriptor — the WebMCP / MCP tool shape. */
export interface ToolDescriptor {
  /** The action this tool performs (`list` | `get` | … | a custom method name). */
  action: string;
  /** Tool id, `${toolPrefix}_${action}` (e.g. `product_list`). */
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  /** True when the declared effect is `read` → WebMCP `annotations.readOnlyHint`. */
  readOnly: boolean;
  /** Capability effect used by browser-tool exposure policy. */
  effect: ToolEffect;
  /** Whether repeating this tool with the same arguments is safe. */
  idempotent: boolean;
  /** Whether the tool may interact outside the SMRT application. */
  openWorld: boolean;
  /** Generated custom-route transport metadata, when the action has a route. */
  route?: ToolRouteDescriptor;
}

/**
 * Map one normalized field to its JSON-Schema fragment. Ported from
 * `MCPGenerator.fieldToMCPSchema` (mcp.ts) — keep the two in lockstep until
 * mcp.ts is switched to call this.
 */
export function fieldTypeToJsonSchema(field: ToolFieldMeta): ToolJsonSchema {
  const schema: ToolJsonSchema = {
    description: field.description || `${field.type} field`,
  };

  switch (field.type) {
    case 'text':
      schema.type = 'string';
      if (field.maxLength !== undefined) schema.maxLength = field.maxLength;
      if (field.minLength !== undefined) schema.minLength = field.minLength;
      break;
    case 'integer':
      schema.type = 'integer';
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      break;
    case 'decimal':
      schema.type = 'number';
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
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
    case 'crossPackageRef':
      schema.type = 'string';
      // The generic relation hint is a fallback only — an authored
      // `@field({ description })` wins (#2046 threads descriptions into web
      // tool descriptors; clobbering them here would strip the help text).
      if (!field.description) {
        schema.description = `ID of related ${field.related || 'object'}`;
      }
      break;
    default:
      schema.type = 'string';
  }

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  if (field.nullable && typeof schema.type === 'string') {
    schema.type = [schema.type, 'null'];
  }

  return schema;
}

function buildFieldProperties(fields: ToolFieldMeta[]): {
  properties: Record<string, ToolJsonSchema>;
  defs: Record<string, ToolJsonSchema>;
} {
  const properties: Record<string, ToolJsonSchema> = {};
  const defs: Record<string, ToolJsonSchema> = {};

  fields.forEach((field, index) => {
    // Numeric keys avoid JSON Pointer escaping and keep output deterministic
    // even for an authored field name containing `/` or `~`.
    const defKey = `field_${index}`;
    defs[defKey] = fieldTypeToJsonSchema(field);
    properties[field.name] = { $ref: `#/$defs/${defKey}` };
  });

  return { properties, defs };
}

/**
 * Build the `inputSchema` for one action. CRUD verbs get the fixed skeletons
 * ported from mcp.ts's `generateObjectTools`; any other action is treated as a
 * custom method taking `{ id, options }`.
 */
export function buildToolInputSchema(
  action: string,
  fields: ToolFieldMeta[],
  customAction?: CustomActionMetadata,
  idType: ToolIdType = 'uuid',
): ToolJsonSchema {
  const identifierSchema = (description: string): ToolJsonSchema => ({
    type: 'string',
    ...(idType === 'uuid' ? { format: 'uuid' } : {}),
    description,
  });

  switch (action) {
    case 'list':
      return finalizeMcpJsonSchema({
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
      });

    case 'get':
      // Either `id` OR `slug` identifies the object (collection.get resolves
      // both). The schema must require one of them just as the handler does,
      // while still allowing slug-only lookups.
      return finalizeMcpJsonSchema({
        type: 'object',
        anyOf: [{ required: ['id'] }, { required: ['slug'] }],
        properties: {
          id: identifierSchema('Unique identifier of the object'),
          slug: {
            type: 'string',
            description: 'URL-friendly identifier of the object',
          },
        },
      });

    case 'create': {
      const { properties, defs } = buildFieldProperties(fields);
      const required: string[] = [];
      for (const field of fields) {
        if (field.required) required.push(field.name);
      }
      return finalizeMcpJsonSchema({
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
      });
    }

    case 'update': {
      const { properties: fieldProperties, defs } =
        buildFieldProperties(fields);
      const properties: Record<string, ToolJsonSchema> = {
        id: identifierSchema('ID of the object to update'),
        ...fieldProperties,
      };
      return finalizeMcpJsonSchema({
        type: 'object',
        properties,
        required: ['id'],
        ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
      });
    }

    case 'delete':
      return finalizeMcpJsonSchema({
        type: 'object',
        properties: {
          id: identifierSchema('ID of the object to delete'),
        },
        required: ['id'],
      });

    default:
      return finalizeMcpJsonSchema(
        buildCustomActionInputSchema(
          customAction ?? {
            scope: 'item',
            idRequired: true,
            isStatic: false,
            effect: 'destructive',
            idempotent: false,
            openWorld: true,
          },
        ),
      );
  }
}

/**
 * Human-readable description for a tool, matching mcp.ts's phrasing so the Node
 * MCP and WebMCP surfaces read identically.
 */
function describeAction(action: string, className: string): string {
  switch (action) {
    case 'list':
      return `List ${className} objects with optional filtering`;
    case 'get':
      return `Get a specific ${className} by ID or slug`;
    case 'create':
      return `Create a new ${className}`;
    case 'update':
      return `Update an existing ${className}`;
    case 'delete':
      return `Delete a ${className} by ID`;
    default:
      return `Execute ${action} action on ${className}`;
  }
}

/**
 * Build the full descriptor set for a model. `toolPrefix` defaults to the
 * lowercased class name so tool ids match the existing Node MCP surface exactly
 * (`product_list`, `invoice_record_payment`), giving one stable tool vocabulary
 * across MCP and WebMCP.
 */
export function buildToolDescriptors(opts: {
  className: string;
  fields: ToolFieldMeta[];
  actions: string[];
  customActions?: Record<string, CustomActionMetadata>;
  toolPrefix?: string;
  idType?: ToolIdType;
}): ToolDescriptor[] {
  const { className, fields, actions } = opts;
  const prefix = (opts.toolPrefix ?? className).toLowerCase();

  return actions.map((action) => {
    const customAction = opts.customActions?.[action];
    const semantics = toolSemantics(action, customAction);
    return {
      action,
      // Custom method names can contain underscores; the runtime splits on the
      // FIRST underscore only (mcp.ts #1378), so a lowercased join is safe here.
      name: `${prefix}_${action}`.toLowerCase(),
      description: describeAction(action, className),
      inputSchema: buildToolInputSchema(
        action,
        fields,
        customAction,
        opts.idType,
      ),
      readOnly: semantics.effect === 'read',
      ...semantics,
    };
  });
}

function toolSemantics(
  action: string,
  customAction?: CustomActionMetadata,
): Pick<ToolDescriptor, 'effect' | 'idempotent' | 'openWorld'> {
  switch (action) {
    case 'list':
    case 'get':
      return { effect: 'read', idempotent: true, openWorld: false };
    case 'create':
      return { effect: 'write', idempotent: false, openWorld: false };
    case 'update':
      return { effect: 'write', idempotent: true, openWorld: false };
    case 'delete':
      return { effect: 'destructive', idempotent: true, openWorld: false };
    default:
      return {
        effect: customAction?.effect ?? 'destructive',
        idempotent: customAction?.idempotent ?? false,
        openWorld: customAction?.openWorld ?? true,
      };
  }
}

/** True when `action` is one of the fixed CRUD verbs (vs. a custom method). */
export function isCrudAction(action: string): boolean {
  return CRUD_ACTIONS.has(action);
}
