import {
  buildCommandTools as buildEngineTools,
  checkSchema as checkEngineSchema,
  type EngineCatalog,
  type CommandTool as EngineCommandTool,
  type JsonSchema,
} from '@happyvertical/smrt-core/cookbook/engine';
import { libraryCookbooks } from '../../library/index.ts';
import { recipes } from '../../recipes/index.ts';
import { engineCatalog } from './catalog.ts';
import { type CommandName, PLANNER_TAB_IDS } from './types.ts';

export type { JsonSchema };

/** One command as an LLM or MCP tool definition. */
export interface CommandTool extends Omit<EngineCommandTool, 'name'> {
  name: CommandName;
}

/**
 * `focus` is the one command the planner adds to the engine's: it moves the
 * view, not the document, so the engine has no such command.
 */
const FOCUS_TOOL: CommandTool = {
  name: 'focus',
  description:
    "Move the planner's view to a tab and/or a menu section. Navigation only; it changes nothing in the plan.",
  inputSchema: {
    type: 'object',
    properties: {
      tab: {
        enum: [...PLANNER_TAB_IDS],
        description: 'The tab to open.',
      },
      section: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'The id of a menu section, as the plan snapshot\'s "sections" lists it.',
      },
    },
    additionalProperties: false,
  },
};

/** The engine's tools for `catalog`, with the planner's `focus` after them. */
export function toolsFor(catalog: EngineCatalog): CommandTool[] {
  return [...(buildEngineTools(catalog) as CommandTool[]), FOCUS_TOOL];
}

/**
 * Build every command's tool definition. `recipeIds` and `cookbookIds` become
 * enums, so grammar-constrained decoding cannot name one that does not exist.
 */
export function buildCommandTools(
  recipeIds: readonly string[],
  cookbookIds: readonly string[],
): CommandTool[] {
  return toolsFor({
    ...engineCatalog(),
    recipes: recipeIds.map((id) => ({
      id,
      label: id,
      models: [],
      nav: [],
      requires: [],
    })),
    cookbooks: cookbookIds.map((id) => ({
      id,
      name: id,
      document: {} as never,
    })),
  });
}

/** Every command as a tool definition, for the planner's own recipes and cookbooks. */
export const commandTools: readonly CommandTool[] = buildCommandTools(
  recipes.map((recipe) => recipe.id),
  libraryCookbooks.map((cookbook) => cookbook.id),
);

/** Every command's input JSON Schema, by name: ready to use as a tool's `inputSchema`. */
export const commandSchemas: Readonly<Record<CommandName, JsonSchema>> =
  Object.fromEntries(
    commandTools.map((tool) => [tool.name, tool.inputSchema]),
  ) as Record<CommandName, JsonSchema>;

export const COMMAND_NAMES: readonly CommandName[] = commandTools.map(
  (tool) => tool.name,
);

/**
 * Check a value against a command schema. Returns the first problem as a
 * sentence naming the path, or null. The engine's own validator, so the
 * exported schemas and the runtime cannot drift.
 */
export function checkSchema(
  schema: JsonSchema,
  value: unknown,
  path = 'input',
): string | null {
  return checkEngineSchema(schema, value, path)?.message ?? null;
}
