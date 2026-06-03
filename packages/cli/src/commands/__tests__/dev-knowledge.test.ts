import { describe, expect, it } from 'vitest';
import { devKnowledgeCommands } from '../dev-knowledge.js';

describe('dev:knowledge commands', () => {
  it('registers the deterministic knowledge command set', () => {
    expect(devKnowledgeCommands['dev:knowledge-index']).toBeDefined();
    expect(devKnowledgeCommands['dev:knowledge-check']).toBeDefined();
    expect(devKnowledgeCommands['dev:knowledge-diff']).toBeDefined();
    expect(
      devKnowledgeCommands['dev:knowledge-check'].options?.format,
    ).toBeDefined();
    expect(
      devKnowledgeCommands['dev:knowledge-diff'].options?.format,
    ).toBeDefined();
  });
});
