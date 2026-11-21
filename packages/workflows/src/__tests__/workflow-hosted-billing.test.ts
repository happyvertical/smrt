/**
 * A workflow step on a hosted tier binding (#5489): the step's call is
 * recorded with `source: hosted`, so hosted spend meters workflow work.
 */
import {
  type InferenceResolver,
  setInferenceGate,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  definePrompt,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorkflowDbs,
  definitionOf,
  driverFor,
  rowsOf,
  scriptedModel,
  valueSchema,
  workflowDb,
} from './harness.js';

/** Every tier bound to the scripted model, as a binding of `source`. */
function binding(source: 'hosted' | 'byo'): InferenceResolver {
  return {
    resolve(request) {
      return {
        tierResolved:
          request.tier === 'auto' ? 'good' : (request.tier as 'good'),
        via: 'resolver',
        target: { model: 'scripted-model', source },
      };
    },
  };
}

beforeEach(() => {
  clearPromptCache();
  PromptRegistry.clear();
  definePrompt({
    key: 'test.workflow.hosted',
    template: 'Propose a value for {input}. {repairErrors}',
    ai: { profile: 'good' },
  });
});

afterEach(async () => {
  setInferenceResolver(undefined);
  setInferenceGate(undefined);
  PromptRegistry.clear();
  await closeWorkflowDbs();
});

describe('workflow steps on a hosted binding (#5489)', () => {
  for (const source of ['hosted', 'byo'] as const) {
    it(`records each step call with source ${source}`, async () => {
      setInferenceResolver(binding(source));
      const db = await workflowDb('sqlite');
      const { model, calls } = scriptedModel(() => ({ output: { value: 1 } }));
      const driver = driverFor(
        db,
        model,
        definitionOf([
          {
            name: 'Propose',
            promptKey: 'test.workflow.hosted',
            schema: valueSchema,
          },
        ]),
        {},
        'tenant-a',
      );
      const started = await driver.start({ input: 'x', ownerId: 'owner-1' });
      expect(await driver.run(started.id, 'owner-1')).toMatchObject({
        status: 'done',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.usageTags).toMatchObject({ source });
      const rows = rowsOf(
        await db.query(
          "SELECT tags, estimated_cost FROM _smrt_ai_usage WHERE operation = 'message'",
        ),
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]?.tags))).toMatchObject({
        source,
        promptKey: 'test.workflow.hosted',
      });
    });
  }
});
