import { createHash } from 'node:crypto';
/** Server-only adapter: persistence/authority remain in the existing M5 workflow. */
import {
  continueMcpWorkflow,
  type McpWorkflowContinuation,
} from '@happyvertical/smrt-app-mcp';
import {
  getActiveJobExecutionContext,
  isRunnerExecutionContext,
} from '@happyvertical/smrt-jobs';
import {
  formResourceSelections,
  type OpenAiFormReply,
  validateOpenAiForm,
  validateOpenAiFormReply,
} from './forms.js';
import { json, keys, record, text } from './validation.js';
export type FormBinding = Pick<
  McpWorkflowContinuation,
  'recordId' | 'revision' | 'inputKey'
>;
export interface BoundFormReply {
  binding: FormBinding;
  schemaDigest: string;
  reply: OpenAiFormReply;
}
function binding(value: unknown): FormBinding {
  json(value);
  const b = record(value);
  keys(b, ['recordId', 'revision', 'inputKey']);
  return {
    recordId: text(b.recordId, 256),
    revision: text(b.revision, 256),
    inputKey: text(b.inputKey, 256),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function schemaDigest(schema: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(validateOpenAiForm(schema))))
    .digest('hex');
}
function equal(a: FormBinding, b: FormBinding) {
  if (
    a.recordId !== b.recordId ||
    a.revision !== b.revision ||
    a.inputKey !== b.inputKey
  )
    throw new Error('Form continuation binding mismatch');
}
/** Bind the reply to the exact server-provided continuation; this is not authority. */
export function bindOpenAiFormReply(
  expected: FormBinding,
  schema: unknown,
  value: unknown,
): BoundFormReply {
  return {
    binding: binding(expected),
    schemaDigest: schemaDigest(schema),
    reply: validateOpenAiFormReply(schema, value),
  };
}
/**
 * Suspend/replay the existing durable task. All pre-suspension work must be
 * read-only or use the application's existing idempotency API. `applyInput`
 * must retain immutable review/revision and domain approval checks in its own
 * transaction. A form reply must never authorize an external action.
 */
export async function continueOpenAiForm<T>(options: {
  binding: McpWorkflowContinuation;
  schema: unknown;
  /** Re-resolve current application authority after all asynchronous selection checks. */
  authorizeApply: (binding: Readonly<FormBinding>) => Promise<boolean>;
  /** Required when a form contains resource pickers; resolve opaque grants server-side. */
  authorizeResource?: (
    uri: string,
    binding: Readonly<FormBinding>,
  ) => Promise<boolean>;
  applyInput: (
    content: Record<string, string | number | boolean | string[]>,
    binding: Readonly<FormBinding>,
  ) => Promise<T>;
}): Promise<{ action: 'accept'; value: T } | { action: 'cancel' | 'decline' }> {
  const context = getActiveJobExecutionContext();
  if (!context || !isRunnerExecutionContext(context) || !context.task)
    throw new Error('Durable form requires an active MCP task');
  const task = context.task;
  const form = validateOpenAiForm(options.schema);
  const expected = Object.freeze(
    binding({
      recordId: options.binding.recordId,
      revision: options.binding.revision,
      inputKey: options.binding.inputKey,
    }),
  );
  if (
    Object.values(form.properties).some((f) => 'x-openai-input' in f) &&
    !options.authorizeResource
  )
    throw new TypeError('Resource pickers require live grant authorization');
  return continueMcpWorkflow({
    binding: options.binding,
    inputSchema: form as unknown as Record<string, unknown>,
    applyReviewed: async (raw, current) => {
      json(raw);
      const envelope = record(raw);
      keys(envelope, ['binding', 'schemaDigest', 'reply']);
      if (envelope.schemaDigest !== schemaDigest(form))
        throw new Error('Form schema revision mismatch');
      equal(expected, binding(envelope.binding));
      equal(expected, current);
      const reply = validateOpenAiFormReply(form, envelope.reply);
      for (const uri of formResourceSelections(form, reply))
        if (!(await options.authorizeResource?.(uri, expected)))
          throw new Error('Resource access denied');
      if (!(await options.authorizeApply(expected)))
        throw new Error('Form access denied');
      await task.assertAuthorized();
      if (reply.action !== 'accept') return reply;
      return {
        action: 'accept' as const,
        value: await options.applyInput(reply.content, expected),
      };
    },
  });
}
/** Structural public store port; a principal/tenant-bound McpTaskStore implements it. */
export interface FormContinuationStore {
  getContinuation(taskId: string): Promise<{
    binding: FormBinding;
    inputRequests: Record<string, unknown>;
  } | null>;
  updateTask(
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<void>;
}
/**
 * Application-form submit path. The deployment supplies its verified actor's
 * tenant-bound existing store and a fresh policy callback. CAS in that store
 * accepts at most one reply; submission is not proof of completion or approval.
 * Worker-side validation remains mandatory even if another caller uses tasks/update.
 */
export async function submitOpenAiForm(options: {
  store: FormContinuationStore;
  taskId: string;
  binding: FormBinding;
  reply: unknown;
  authorize: () => Promise<boolean>;
}): Promise<void> {
  text(options.taskId, 256);
  const expected = binding(options.binding);
  if (!(await options.authorize())) throw new Error('Form access denied');
  const current = await options.store.getContinuation(options.taskId);
  if (!current) throw new Error('Form is not awaiting input');
  equal(expected, current.binding);
  const request = record(current.inputRequests[expected.inputKey]);
  const answer = bindOpenAiFormReply(expected, request.schema, options.reply);
  if (!(await options.authorize())) throw new Error('Form access denied');
  await options.store.updateTask(options.taskId, {
    [expected.inputKey]: answer,
  });
}
