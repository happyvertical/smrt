import {
  createMcpWorkflowTool,
  type McpAppPrincipal,
  type McpAppServer,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import type {
  MCPTool,
  ToolJsonSchema,
} from '@happyvertical/smrt-core/generators/mcp';
import {
  type SettingsSchema,
  validateSettingsRead,
  validateSettingsSchema,
  validateSettingsValues,
} from './settings.js';
import {
  appRelativeUrl,
  displayMode,
  json,
  keys,
  type OpenAiDisplayMode,
  record,
  text,
  toolName,
} from './validation.js';

export type {
  SettingSchema,
  SettingsGroup,
  SettingsReadResult,
  SettingsSchema,
} from './settings.js';
export {
  validateSettingsRead,
  validateSettingsSchema,
  validateSettingsValues,
} from './settings.js';
export type { OpenAiDisplayMode } from './validation.js';
export { appRelativeUrl, OPENAI_EXTENSIONS_REVISION } from './validation.js';
export const EMPTY_ARGUMENTS_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
function empty(args: unknown): void {
  json(args);
  if (Object.keys(record(args)).length)
    throw new TypeError('Expected empty arguments');
}
function acceptsEmpty(schema: ToolJsonSchema): void {
  json(schema);
  // A deliberate, provable subset; arbitrary combinators cannot establish {} safety.
  keys(record(schema), [
    'type',
    'properties',
    'additionalProperties',
    'required',
    'description',
    'title',
  ]);
  if (
    schema.type !== 'object' ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.length))
  )
    throw new TypeError('Tool must accept empty arguments');
  if (schema.properties !== undefined) record(schema.properties);
}
/** Annotate an existing authorized read workflow; no alternative dispatch path. */
export function withOpenAiEntrypoints(
  definition: McpWorkflowToolDefinition,
  entrypoints: readonly ('global' | 'thread')[],
): McpWorkflowToolDefinition {
  createMcpWorkflowTool(definition);
  acceptsEmpty(definition.inputSchema);
  if (
    !definition.ui?.resourceUri ||
    definition.effect !== 'read' ||
    !definition.idempotent
  )
    throw new TypeError('Entrypoints require an idempotent read UI tool');
  if (
    !Array.isArray(entrypoints) ||
    !entrypoints.length ||
    entrypoints.length > 2 ||
    new Set(entrypoints).size !== entrypoints.length ||
    entrypoints.some((type) => type !== 'global' && type !== 'thread')
  )
    throw new TypeError('Invalid entrypoints');
  if (definition.metadata && Object.hasOwn(definition.metadata, 'openai/ui'))
    throw new TypeError('OpenAI entrypoint metadata already declared');
  return {
    ...definition,
    metadata: {
      ...structuredClone(definition.metadata ?? {}),
      'openai/ui': { entrypoints: entrypoints.map((type) => ({ type })) },
    },
  };
}
/** Resource content metadata (not tool metadata). Omitted fields preserve upstream defaults. */
export function openAiDisplayMetadata(
  options: {
    availableDisplayModes?: OpenAiDisplayMode[];
    preferredDisplayMode?: OpenAiDisplayMode;
  } = {},
): Record<string, unknown> {
  json(options);
  keys(record(options), ['availableDisplayModes', 'preferredDisplayMode']);
  const modes = options.availableDisplayModes?.map(displayMode);
  const preferred =
    options.preferredDisplayMode === undefined
      ? undefined
      : displayMode(options.preferredDisplayMode);
  if (
    modes &&
    (!modes.length ||
      modes.length > 2 ||
      new Set(modes).size !== modes.length ||
      (preferred && !modes.includes(preferred)))
  )
    throw new TypeError('Invalid display modes');
  return {
    'openai/ui': {
      ...(modes ? { availableDisplayModes: modes } : {}),
      ...(preferred ? { preferredDisplayMode: preferred } : {}),
    },
  };
}
/** Manifest declaration only. M7 validates the referenced packaged asset. */
export function openAiOnboardingDeclaration(skill: string): {
  extensions: { 'com.openai': { onboardingSkill: string } };
} {
  text(skill, 512);
  if (!/^\.\/skills\/(?:[A-Za-z0-9_-]+\/)+SKILL\.md$/.test(skill))
    throw new TypeError('Expected relative packaged onboarding skill');
  return { extensions: { 'com.openai': { onboardingSkill: skill } } };
}
export interface OpenAiSettingsBinding {
  readTool: string;
  updateTool: string;
  workflows: [McpWorkflowToolDefinition, McpWorkflowToolDefinition];
  /** Pass to the app-MCP protocol extension callback; input must be its authorized catalog. */
  extensions(
    tools: readonly MCPTool[],
  ): Record<string, Record<string, unknown>>;
}
/** Wrap existing read/atomic-assignment workflows. Their execution and authorization remain app-owned. */
export function bindOpenAiSettings(options: {
  schema: SettingsSchema;
  read: McpWorkflowToolDefinition;
  update: McpWorkflowToolDefinition;
  /** Resolve the same server after composition, for authorized layout tool references. */
  server: () => McpAppServer;
}): OpenAiSettingsBinding {
  const schema = validateSettingsSchema(options.schema);
  const read = options.read;
  const update = options.update;
  createMcpWorkflowTool(read);
  createMcpWorkflowTool(update);
  acceptsEmpty(read.inputSchema);
  if (
    read.name === update.name ||
    read.effect !== 'read' ||
    !read.idempotent ||
    update.effect !== 'write' ||
    !update.idempotent
  )
    throw new TypeError(
      'Settings require distinct read and idempotent assignment workflows',
    );
  const readDefinition: McpWorkflowToolDefinition = {
    ...read,
    inputSchema: structuredClone(EMPTY_ARGUMENTS_SCHEMA),
    outputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'object' },
        values: { type: 'object' },
        layout: { type: 'array', items: { type: 'object' } },
      },
      required: ['schema', 'values'],
    },
    async execute(context) {
      empty(context.arguments);
      const result = await read.execute(context);
      if (result.isError) return result;
      const settings = validateSettingsRead(result.structuredContent, schema);
      const allowed = await options
        .server()
        .listTools({ principal: context.principal });
      for (const group of settings.layout ?? []) {
        group.items = group.items.filter((item) => {
          if (item.kind !== 'tool') return true;
          const tool = allowed.find((tool) => tool.name === item.tool);
          if (!tool) return false;
          acceptsEmpty(tool.inputSchema);
          return true;
        });
      }
      return { ...result, structuredContent: { ...settings } };
    },
  };
  const updateDefinition: McpWorkflowToolDefinition = {
    ...update,
    inputSchema: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          properties: structuredClone(schema.properties),
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['set'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { values: { type: 'object' } },
      required: ['values'],
    },
    async execute(context) {
      json(context.arguments);
      keys(record(context.arguments), ['set']);
      const set = validateSettingsValues(context.arguments.set, schema, true);
      if (!Object.keys(set).length)
        throw new TypeError('Expected changed settings');
      const result = await update.execute({ ...context, arguments: { set } });
      if (result.isError) return result;
      json(result.structuredContent);
      const output = record(result.structuredContent);
      keys(output, ['values']);
      return {
        ...result,
        structuredContent: {
          values: validateSettingsValues(output.values, schema),
        },
      };
    },
  };
  return {
    readTool: read.name,
    updateTool: update.name,
    workflows: [readDefinition, updateDefinition],
    extensions(tools): Record<string, Record<string, unknown>> {
      const names = new Set(tools.map((tool) => tool.name));
      return names.has(read.name) && names.has(update.name)
        ? {
            'openai/settings': { readTool: read.name, updateTool: update.name },
          }
        : {};
    },
  };
}
/** Resolve untrusted route data through the existing server policy and domain read handler. */
export async function resolveOpenAiNavigationTarget(options: {
  server: McpAppServer;
  tool: string;
  url: string;
  principal: McpAppPrincipal | null;
}) {
  const name = toolName(options.tool);
  const url = appRelativeUrl(options.url);
  const catalog = await options.server.listTools({
    principal: options.principal,
  });
  const tool = catalog.find((tool) => tool.name === name);
  if (!tool || tool.annotations?.readOnlyHint !== true)
    throw new Error('Navigation target unavailable');
  return options.server.callTool({
    name,
    arguments: { url },
    principal: options.principal,
  });
}
