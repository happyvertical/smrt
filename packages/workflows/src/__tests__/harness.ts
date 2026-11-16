/**
 * Test harness: a real database with core's system tables, core's real
 * tracked client over a scripted model (no provider is called), registered
 * prompts and Ajv as the host validator. No containers.
 */
import {
  createTrackedAiClient,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import { definePrompt, PromptRegistry } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv from 'ajv/dist/2020.js';
import {
  createWorkflowRunDriver,
  type WorkflowDefinition,
  type WorkflowRunDriverOptions,
  type WorkflowStep,
} from '../index.js';

export type Engine = 'sqlite' | 'duckdb' | 'pglite';

const open: DatabaseInterface[] = [];

export async function workflowDb(
  engine: Engine = 'sqlite',
  classes: string[] = [],
): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: engine,
    classes: ['PromptOverride', ...classes],
  });
  open.push(db);
  return db;
}

export async function closeWorkflowDbs(): Promise<void> {
  for (const db of open.splice(0)) {
    await (db as { close?: () => Promise<void> }).close?.();
  }
}

export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** What the scripted model answers for one call. */
export interface ScriptedAnswer {
  output: unknown;
  tokens?: number;
}

/** One call the scripted model received. */
export interface ScriptedCall {
  text: string;
  options: Record<string, unknown>;
}

/**
 * A model client the tracked client wraps: answers with the script's output
 * (as JSON text) and reports its usage on the answer, the way a `chat()`
 * response does.
 */
export function scriptedModel(
  script: (
    call: ScriptedCall,
    index: number,
  ) => Promise<ScriptedAnswer> | ScriptedAnswer,
) {
  const calls: ScriptedCall[] = [];
  const model = {
    async embed() {
      return [];
    },
    async message(text: string, options: Record<string, unknown> = {}) {
      const call = { text, options };
      calls.push(call);
      const answer = await script(call, calls.length - 1);
      const tokens = answer.tokens ?? 10;
      return {
        content:
          typeof answer.output === 'string'
            ? answer.output
            : JSON.stringify(answer.output),
        model: 'scripted-model',
        usage: {
          promptTokens: Math.floor(tokens / 2),
          completionTokens: tokens - Math.floor(tokens / 2),
          totalTokens: tokens,
        },
      };
    },
  };
  return { model, calls };
}

export const valueSchema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: { type: 'number' } },
};

const ajv = new Ajv({ strict: true, allErrors: true });
export const validate: WorkflowRunDriverOptions['validate'] = (
  schema,
  output,
) => {
  const check = ajv.compile(schema);
  return check(output)
    ? []
    : (check.errors ?? []).map((error) => error.message ?? 'invalid');
};

/** Register the test prompts (each test file clears the registry first). */
export function definePrompts(): void {
  PromptRegistry.clear();
  definePrompt({
    key: 'test.workflow.propose',
    template: 'Propose a value for {input}. {repairErrors}',
  });
  definePrompt({
    key: 'test.workflow.refine',
    template: 'Refine {outputs}. {repairErrors}',
  });
}

export const twoSteps: WorkflowStep[] = [
  { name: 'Propose', promptKey: 'test.workflow.propose', schema: valueSchema },
  { name: 'Refine', promptKey: 'test.workflow.refine', schema: valueSchema },
];

export function definitionOf(
  steps: WorkflowStep[] = twoSteps,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { key: 'test:design', version: '1', steps, ...extra };
}

/** A driver on core's tracked client over a scripted model. */
export function driverFor(
  db: DatabaseInterface,
  model: ReturnType<typeof scriptedModel>['model'],
  definition: WorkflowDefinition = definitionOf(),
  extra: Partial<WorkflowRunDriverOptions> = {},
  tenantId: string | null = null,
) {
  const ai = createTrackedAiClient({
    db,
    tenantId,
    ai: model as never,
  });
  return createWorkflowRunDriver({ ai, definition, validate, ...extra });
}

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await delay(10);
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
