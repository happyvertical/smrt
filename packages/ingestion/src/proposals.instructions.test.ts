import { describe, expect, it } from 'vitest';
import type { GenerationOutput } from './proposal-dto.js';
import { proposalInstructions, proposalInstructionsFor } from './proposals.js';

describe('proposal instructions', () => {
  it('states every validator-required transport rule without contradicting it', () => {
    expect(proposalInstructions).toContain('all required top-level keys');
    expect(proposalInstructions).toContain('Always include splits');
    expect(proposalInstructions).toContain('must never contain segments');
    expect(proposalInstructions).toContain('exact offered key');
    expect(proposalInstructions).not.toContain('Splits are optional');
  });

  it('distinguishes candidate keys from the ids accepted by handler args', () => {
    const offered: GenerationOutput['offered'] = [
      {
        handler: {
          id: 'identify-assignment',
          version: '1',
          description: 'Identify an assignment.',
          kind: 'operation',
          capability: { effect: 'read', idempotent: true, openWorld: false },
          argsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['lessonId'],
            properties: { lessonId: { type: 'string' } },
          },
          references: { lessonId: { kind: 'candidate', model: 'Lesson' } },
          operation: { model: 'Lesson', action: 'get', version: '1' },
        },
        candidates: [
          {
            key: 'opaque-candidate-key',
            model: 'Lesson',
            id: 'lesson-uuid',
            revision: '3',
            label: 'Addition practice',
          },
        ],
      },
    ];
    const instructions = proposalInstructionsFor(offered);
    expect(instructions).toContain('"id":"lesson-uuid"');
    expect(instructions).toContain('"key":"opaque-candidate-key"');
    expect(instructions).toContain("candidate's id into args");
    expect(instructions).toContain('never emit a bare handlerId');
  });
});
