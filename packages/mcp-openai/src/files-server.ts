import {
  createMcpWorkflowTool,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { fileExtensions, validateFileInput } from './file-contracts.js';

export type { OpenAiFileInput } from './file-contracts.js';
export { validateFileInput } from './file-contracts.js';
/** Wrap an existing authorized provider/view workflow. Input is a reference, never a grant. */
export function withOpenAiFileEntrypoint(
  definition: McpWorkflowToolDefinition,
  extensions: readonly string[],
): McpWorkflowToolDefinition {
  createMcpWorkflowTool(definition);
  const allowed = fileExtensions(extensions);
  if (
    !definition.ui?.resourceUri ||
    definition.effect !== 'read' ||
    !definition.idempotent
  )
    throw new TypeError('File entrypoint requires idempotent read UI workflow');
  if (definition.metadata && Object.hasOwn(definition.metadata, 'openai/ui'))
    throw new TypeError('File entrypoint metadata already declared');
  return {
    ...definition,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            resourceUri: { type: 'string' },
          },
          required: ['name', 'resourceUri'],
          additionalProperties: false,
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    metadata: {
      ...structuredClone(definition.metadata ?? {}),
      'openai/ui': { entrypoints: [{ type: 'file', extensions: allowed }] },
    },
    execute(context) {
      const input = validateFileInput(context.arguments);
      if (
        !allowed.some((extension) =>
          input.file.name.toLowerCase().endsWith(extension),
        )
      )
        throw new TypeError('File extension denied');
      // Existing handler must resolve ownership/tenant from context.principal, never metadata.
      return definition.execute({ ...context, arguments: { ...input } });
    },
  };
}
