import { DEFAULT_THEME_PRESETS, MAX_TERMS_LENGTH } from './defaults.js';
import type {
  CommandName,
  CommandTool,
  EngineCatalog,
  JsonSchema,
} from './types.js';

const ids = (description: string, values?: readonly string[]): JsonSchema => ({
  type: 'array',
  description,
  minItems: 1,
  maxItems: 50,
  items: values?.length
    ? { type: 'string', enum: [...values] }
    : { type: 'string', minLength: 1 },
});

const text = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: 'string',
  description,
  minLength: 1,
  maxLength: 200,
  ...extra,
});

const object = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/**
 * Every command as an MCP/LLM tool definition (`inputSchema` is JSON Schema
 * 2020-12). Recipe and cookbook ids become enums from the catalog, so
 * grammar-constrained decoding cannot name one that does not exist.
 */
export function buildCommandTools(catalog: EngineCatalog): CommandTool[] {
  const recipeIds = catalog.recipes.map((r) => r.id);
  const cookbookIds = (catalog.cookbooks ?? []).map((c) => c.id);
  const presets = catalog.themePresets ?? DEFAULT_THEME_PRESETS;
  const cookbookId = (description: string): JsonSchema => ({
    type: 'string',
    description,
    ...(cookbookIds.length ? { enum: [...cookbookIds] } : { minLength: 1 }),
  });
  const entryId = (what: string): JsonSchema =>
    text(`The id of ${what}, as the plan snapshot's "sections" lists it.`);
  const replace: JsonSchema = {
    type: 'boolean',
    description: 'Confirm replacing what is there.',
  };
  return [
    {
      name: 'add_recipes',
      description:
        'Switch recipes on. Recipes they require come along. Returns what was added.',
      inputSchema: object({ ids: ids('Recipe ids to add.', recipeIds) }, [
        'ids',
      ]),
    },
    {
      name: 'remove_recipes',
      description:
        'Switch recipes off. A recipe another one needs is kept and reported.',
      inputSchema: object({ ids: ids('Recipe ids to remove.', recipeIds) }, [
        'ids',
      ]),
    },
    {
      name: 'add_features',
      description:
        'Add single models no recipe covers, by qualified name (`@scope/pkg:Class`).',
      inputSchema: object({ ids: ids('Qualified model names to add.') }, [
        'ids',
      ]),
    },
    {
      name: 'remove_features',
      description: 'Remove single models added with add_features.',
      inputSchema: object({ ids: ids('Qualified model names to remove.') }, [
        'ids',
      ]),
    },
    {
      name: 'add_cookbook',
      description:
        'Add the recipes and features of a ready-made cookbook to the current app. Nothing is replaced.',
      inputSchema: object({ id: cookbookId('The cookbook to add.') }, ['id']),
    },
    {
      name: 'remove_cookbook',
      description:
        'Remove the recipes and features a ready-made cookbook adds. Ones another recipe needs are kept.',
      inputSchema: object({ id: cookbookId('The cookbook to remove.') }, [
        'id',
      ]),
    },
    {
      name: 'apply_cookbook',
      description:
        'Select a ready-made cookbook: replace the whole app (recipes, options, menu, theme) with it. When the app has anything in it, replace must be true.',
      inputSchema: object(
        { id: cookbookId('The cookbook to set up.'), replace },
        ['id'],
      ),
    },
    {
      name: 'import_cookbook',
      description:
        'Replace the whole app with a cookbook document (version 1). Checked strictly; nothing is applied if it is invalid. When the app has anything in it, replace must be true.',
      inputSchema: object(
        {
          document: {
            type: 'object',
            description: 'A cookbook document, version 1.',
          },
          replace,
        },
        ['document'],
      ),
    },
    {
      name: 'set_settings',
      description:
        'Change app settings: currency, default tax rate (percent), default payment terms. Applies to new records only.',
      inputSchema: object({
        currency: catalog.currencies?.length
          ? {
              type: 'string',
              description: 'ISO 4217 code, e.g. CAD.',
              enum: [...catalog.currencies],
            }
          : {
              type: 'string',
              description: 'ISO 4217 code, e.g. CAD.',
              pattern: '^[A-Z]{3}$',
            },
        taxRate: {
          type: 'number',
          description: 'Default tax rate in percent, 0 to 100.',
          minimum: 0,
          maximum: 100,
        },
        paymentTerms: {
          type: 'string',
          description: 'Default payment terms, e.g. "Net 30".',
          minLength: 1,
          maxLength: MAX_TERMS_LENGTH,
        },
      }),
    },
    {
      name: 'set_policy',
      description:
        "Set one field's policy: default value, visibility, label or help. The model must be covered by a recipe or feature that is on. null clears a part.",
      inputSchema: object(
        {
          model: text(
            'Qualified model name, e.g. @happyvertical/smrt-commerce:Order.',
          ),
          field: text('The model field name.'),
          defaultValue: {
            description:
              'The default as a JSON value (a string, number or boolean). null clears it.',
          },
          visibility: {
            enum: ['basic', 'advanced', 'hidden', null],
            description: 'Whether the field shows in forms and lists.',
          },
          label: {
            type: ['string', 'null'],
            description: 'A different label.',
            maxLength: 120,
          },
          help: {
            type: ['string', 'null'],
            description: 'Help text under the field.',
            maxLength: 400,
          },
        },
        ['model', 'field'],
      ),
    },
    {
      name: 'set_theme',
      description:
        'Change the look: a preset, a brand colour, light or dark. A preset replaces a brand colour.',
      inputSchema: object({
        preset: { enum: [...presets], description: 'A built-in theme.' },
        primary: {
          type: 'string',
          description: 'Brand colour as #rrggbb.',
          pattern: '^#[0-9a-fA-F]{6}$',
        },
        colorScheme: {
          enum: ['light', 'dark', 'system'],
          description: 'Light, dark or follow the device.',
        },
        fontFamily: {
          type: ['string', 'null'],
          minLength: 1,
          description: 'Font key. Null restores the preset font.',
        },
        borderRadius: {
          enum: ['none', 'sm', 'md', 'lg', 'xl', 'full'],
          description: 'Corner roundness.',
        },
        density: {
          enum: ['comfortable', 'touch'],
          description: 'Control size: comfortable, or larger touch targets.',
        },
        contrast: {
          enum: ['auto', 'standard', 'more'],
          description:
            'Contrast: auto follows the device, or force standard or more.',
        },
      }),
    },
    {
      name: 'reset_theme',
      description: 'Go back to the default look.',
      inputSchema: object({}),
    },
    {
      name: 'set_name',
      description: 'Name and describe the app. null clears a part.',
      inputSchema: object({
        name: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
        description: {
          type: ['string', 'null'],
          minLength: 1,
          maxLength: 400,
        },
      }),
    },
    {
      name: 'rename_section',
      description: 'Rename a menu section.',
      inputSchema: object(
        {
          id: entryId('the section'),
          label: text('The new name.', { maxLength: 60 }),
        },
        ['id', 'label'],
      ),
    },
    {
      name: 'rename_item',
      description: 'Rename a menu entry. A null label restores its own name.',
      inputSchema: object(
        {
          id: entryId('the entry'),
          label: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
        },
        ['id', 'label'],
      ),
    },
    {
      name: 'hide',
      description: 'Hide a menu section or entry. Nothing is deleted.',
      inputSchema: object({ id: entryId('the section or entry') }, ['id']),
    },
    {
      name: 'show',
      description: 'Show a hidden menu section or entry again.',
      inputSchema: object({ id: entryId('the section or entry') }, ['id']),
    },
    {
      name: 'validate',
      description:
        'Check the current cookbook against the catalog and report typed diagnostics. Changes nothing.',
      inputSchema: object({}),
    },
    {
      name: 'export_cookbook',
      description:
        'The cookbook as a <name>.cookbook.json file (text in the result). Changes nothing.',
      inputSchema: object({
        name: text('A name for the file.', { maxLength: 60 }),
      }),
    },
    {
      name: 'undo',
      description:
        'Undo an earlier change by the undoId its receipt carried. Refused with a conflict when the plan changed since, unless force is true.',
      inputSchema: object(
        {
          undoId: text('The undoId from a receipt.'),
          force: {
            type: 'boolean',
            description: 'Undo even after later edits.',
          },
        },
        ['undoId'],
      ),
    },
  ];
}

/**
 * The batch envelope as a tool definition: several commands, applied
 * all-or-nothing. Commands inside are validated against their own schemas.
 */
export function buildBatchTool(catalog: EngineCatalog): {
  name: 'run_batch';
  description: string;
  inputSchema: JsonSchema;
} {
  return {
    name: 'run_batch',
    description:
      'Run several commands as one atomic batch: all apply or none does. A failure names the command and leaves the plan unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 200 },
        expectedRevision: { type: 'integer', minimum: 0 },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            oneOf: buildCommandTools(catalog).map((tool) => ({
              type: 'object',
              properties: {
                name: { const: tool.name },
                input: tool.inputSchema,
              },
              required: ['name'],
              additionalProperties: false,
            })),
          },
        },
      },
      required: ['commands'],
      additionalProperties: false,
    },
  };
}

const typeOf = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value;

function typeMatches(wanted: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === wanted || (wanted === 'number' && actual === 'integer');
}

/**
 * Check a value against a command schema (the subset the commands use). One
 * validator for runtime and exported schemas, so they cannot drift. Returns
 * the first problem as `{ path, message }`, or null.
 */
export function checkSchema(
  schema: JsonSchema,
  value: unknown,
  path = 'input',
): { path: string; message: string } | null {
  const bad = (message: string) => ({ path, message: `${path} ${message}` });
  const type = schema.type as string | string[] | undefined;
  if (type) {
    const wanted = Array.isArray(type) ? type : [type];
    if (!wanted.some((t) => typeMatches(t, value))) {
      return bad(`must be ${wanted.join(' or ')}`);
    }
  }
  const choices = schema.enum as unknown[] | undefined;
  if (choices && !choices.includes(value)) {
    return bad(
      choices.length > 12
        ? 'is not a known value'
        : `must be one of ${choices.map((c) => JSON.stringify(c)).join(', ')}`,
    );
  }
  if (typeof value === 'string') {
    const { minLength, maxLength, pattern } = schema as {
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    };
    if (minLength !== undefined && value.length < minLength) {
      return bad('must not be empty');
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return bad(`must be at most ${maxLength} characters`);
    }
    if (pattern && !new RegExp(pattern).test(value)) {
      return bad('has the wrong format');
    }
  }
  if (typeof value === 'number') {
    const { minimum, maximum } = schema as {
      minimum?: number;
      maximum?: number;
    };
    if (!Number.isFinite(value)) return bad('must be a finite number');
    if (minimum !== undefined && value < minimum) {
      return bad(`must be at least ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
      return bad(`must be at most ${maximum}`);
    }
  }
  if (Array.isArray(value)) {
    const { minItems, maxItems, items } = schema as {
      minItems?: number;
      maxItems?: number;
      items?: JsonSchema;
    };
    if (minItems !== undefined && value.length < minItems) {
      return bad(`needs at least ${minItems} item${minItems === 1 ? '' : 's'}`);
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return bad(`takes at most ${maxItems} items`);
    }
    if (items) {
      for (const [index, item] of value.entries()) {
        const problem = checkSchema(items, item, `${path}[${index}]`);
        if (problem) return problem;
      }
    }
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const { properties, required, additionalProperties } = schema as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    };
    for (const key of required ?? []) {
      if (object[key] === undefined) {
        return {
          path: `${path}.${key}`,
          message: `${path}.${key} is required`,
        };
      }
    }
    for (const [key, entry] of Object.entries(object)) {
      const child = properties?.[key];
      if (!child) {
        if (additionalProperties === false) {
          return {
            path: `${path}.${key}`,
            message: `${path}.${key} is not an option of this command`,
          };
        }
        continue;
      }
      if (entry === undefined) continue;
      const problem = checkSchema(child, entry, `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

export type CommandSchemas = Readonly<Record<CommandName, JsonSchema>>;

/** The input schemas by command name. */
export function commandSchemas(catalog: EngineCatalog): CommandSchemas {
  return Object.fromEntries(
    buildCommandTools(catalog).map((tool) => [tool.name, tool.inputSchema]),
  ) as CommandSchemas;
}
