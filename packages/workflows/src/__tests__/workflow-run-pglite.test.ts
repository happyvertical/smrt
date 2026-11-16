/**
 * Workflow runs on PostgreSQL's dialect, in-process (PGlite): no server, no
 * container (#5005).
 */
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe } from 'vitest';
import { closeWorkflowDbs, definePrompts, workflowDb } from './harness.js';
import { workflowScenarios } from './scenarios.js';

beforeEach(() => {
  clearPromptCache();
  definePrompts();
});
afterEach(async () => {
  PromptRegistry.clear();
  await closeWorkflowDbs();
});

describe('workflow runs on PGlite', () => {
  workflowScenarios(() => workflowDb('pglite'));
});
