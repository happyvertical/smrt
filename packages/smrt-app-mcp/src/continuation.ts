import {
  getActiveJobExecutionContext,
  isRunnerExecutionContext,
  type McpTaskContinuation,
  type McpTaskStore,
} from '@happyvertical/smrt-jobs';
import { McpAccessError } from './errors.js';
import type { McpAppPrincipal } from './server.js';
import {
  createMcpWorkflowTool,
  type McpWorkflowToolDefinition,
} from './workflow-tools.js';

/** Server-owned immutable review reference; contains no permission snapshot. */
export interface McpWorkflowContinuation extends McpTaskContinuation {
  /** Application review page, including the application's own authentication. */
  reviewUrl: string;
}

/**
 * Compose a durable job with its owning workflow. The host answer is only an
 * input hint. `applyReviewed` must call the owning immutable review/revision and
 * idempotency API, rechecking domain approval inside that transaction.
 * No host callback or server session survives suspension.
 */
export async function continueMcpWorkflow<T>(options: {
  binding: McpWorkflowContinuation;
  inputSchema: Record<string, unknown>;
  applyReviewed: (
    input: unknown,
    binding: Readonly<McpTaskContinuation>,
  ) => Promise<T>;
}): Promise<T> {
  const context = getActiveJobExecutionContext();
  if (!context || !isRunnerExecutionContext(context) || !context.task) {
    throw new Error('Durable workflow requires an active MCP task');
  }
  const url = new URL(options.binding.reviewUrl);
  const loopback =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password
  ) {
    throw new Error('Workflow review URL must use HTTPS without credentials');
  }
  await context.task.assertAuthorized();
  const binding = Object.freeze({
    recordId: options.binding.recordId,
    revision: options.binding.revision,
    inputKey: options.binding.inputKey,
  });
  const input = await context.task.requestContinuation(binding, {
    schema: options.inputSchema,
    reviewUrl: url.href,
  });
  await context.task.assertAuthorized();
  return options.applyReviewed(input, binding);
}

/**
 * Declare the ordinary tool fallback for hosts without elicitation. `storeFor`
 * must return a store bound to the supplied verified actor and active tenant;
 * the application policy callback resolves current read authority.
 */
export function createMcpContinuationTool(options: {
  name: string;
  storeFor: (
    principal: McpAppPrincipal,
  ) => Promise<Pick<McpTaskStore, 'getContinuation'>>;
  authorize: (principal: McpAppPrincipal, taskId: string) => Promise<boolean>;
}): McpWorkflowToolDefinition {
  const definition: McpWorkflowToolDefinition = {
    name: options.name,
    description:
      'Read the current input form or human review URL for your waiting workflow task.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['taskId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        continuation: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      },
      required: ['continuation'],
      additionalProperties: false,
    },
    async execute(context) {
      const taskId = context.arguments.taskId;
      const principal = context.principal;
      try {
        if (
          !principal ||
          typeof taskId !== 'string' ||
          !taskId ||
          taskId.length > 256 ||
          !(await options.authorize(principal, taskId))
        )
          throw new Error('Denied');
        const store = await options.storeFor(principal);
        const data = { continuation: await store.getContinuation(taskId) };
        return {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } catch {
        throw new McpAccessError(403, 'Tool access denied');
      }
    },
  };
  createMcpWorkflowTool(definition);
  return definition;
}
