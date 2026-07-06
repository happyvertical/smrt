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
  /** For `foreignKey`: the related class name, for the generated description. */
  related?: string;
}

/** The CRUD verbs with dedicated input-schema skeletons; anything else is custom. */
const CRUD_ACTIONS = new Set(['list', 'get', 'create', 'update', 'delete']);

/** A single generated tool descriptor — the WebMCP / MCP tool shape. */
export interface ToolDescriptor {
  /** The action this tool performs (`list` | `get` | … | a custom method name). */
  action: string;
  /** Tool id, `${toolPrefix}_${action}` (e.g. `product_list`). */
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  /** True for non-mutating reads (`list`/`get`) → WebMCP `annotations.readOnlyHint`. */
  readOnly: boolean;
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
      schema.type = 'string';
      schema.description = `ID of related ${field.related || 'object'}`;
      break;
    default:
      schema.type = 'string';
  }

  if (field.default !== undefined) {
    schema.default = field.default;
  }

  return schema;
}

/**
 * Build the `inputSchema` for one action. CRUD verbs get the fixed skeletons
 * ported from mcp.ts's `generateObjectTools`; any other action is treated as a
 * custom method taking `{ id, options }`.
 */
export function buildToolInputSchema(
  action: string,
  fields: ToolFieldMeta[],
): ToolJsonSchema {
  switch (action) {
    case 'list':
      return {
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
      };

    case 'get':
      return {
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
      };

    case 'create': {
      const properties: Record<string, ToolJsonSchema> = {};
      const required: string[] = [];
      for (const field of fields) {
        properties[field.name] = fieldTypeToJsonSchema(field);
        if (field.required) required.push(field.name);
      }
      return { type: 'object', properties, required };
    }

    case 'update': {
      const properties: Record<string, ToolJsonSchema> = {
        id: { type: 'string', description: 'ID of the object to update' },
      };
      for (const field of fields) {
        properties[field.name] = fieldTypeToJsonSchema(field);
      }
      return { type: 'object', properties, required: ['id'] };
    }

    case 'delete':
      return {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID of the object to delete' },
        },
        required: ['id'],
      };

    default:
      // Custom method: mirrors mcp.ts's custom-action tool shape.
      return {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'ID of the object to execute action on',
          },
          options: {
            type: 'object',
            description: 'Additional options for the custom action',
            additionalProperties: true,
          },
        },
        required: ['id'],
      };
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
  toolPrefix?: string;
}): ToolDescriptor[] {
  const { className, fields, actions } = opts;
  const prefix = (opts.toolPrefix ?? className).toLowerCase();

  return actions.map((action) => ({
    action,
    // Custom method names can contain underscores; the runtime splits on the
    // FIRST underscore only (mcp.ts #1378), so a lowercased join is safe here.
    name: `${prefix}_${action}`.toLowerCase(),
    description: describeAction(action, className),
    inputSchema: buildToolInputSchema(action, fields),
    readOnly: action === 'list' || action === 'get',
  }));
}

/** True when `action` is one of the fixed CRUD verbs (vs. a custom method). */
export function isCrudAction(action: string): boolean {
  return CRUD_ACTIONS.has(action);
}
