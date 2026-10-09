import { expect, test } from 'vitest';
import { ATTACH, CREATE } from '../reference/handlers.js';
import type { GenerationOutput } from '../src/proposal-dto.js';
import { projectGeneration } from './prediction.js';

const mapping = {
  caseId: 'case',
  corpusManifestSha256: 'a'.repeat(64),
  entries: [
    { logical: 'target', actual: '11111111-1111-4111-8111-111111111111' },
    { logical: 'evidence', actual: '22222222-2222-4222-8222-222222222222' },
  ],
};
function output(
  outcome: GenerationOutput['outcome'],
  suggestions: GenerationOutput['suggestions'] = [],
): GenerationOutput {
  return { outcome, suggestions, omittedSuggestions: 0 } as GenerationOutput;
}
function offer(handlerId: string, args: Record<string, unknown>) {
  return {
    handlerId,
    handlerVersion: '1',
    args,
    evidence: [],
    alternatives: [],
    missingFields: [],
    explanation: 'fixture',
    disposition: 'needs_review' as const,
  };
}
test('every offer is retained independently of human execution eligibility; inverse IDs are exact', () => {
  const projected = projectGeneration(
    'case',
    output('proposals', [
      offer(CREATE, { title: 'wrong', body: 'wrong' }),
      offer(ATTACH, {
        contentId: mapping.entries[0].actual,
        evidenceId: mapping.entries[1].actual,
      }),
      offer(ATTACH, {
        contentId: 'unknown',
        evidenceId: mapping.entries[1].actual,
      }),
    ]),
    mapping,
    true,
  );
  expect(projected.actions).toHaveLength(3);
  expect(projected.actions[1]).toMatchObject({
    target: 'target',
    fields: { contentId: 'target', evidenceId: 'evidence' },
  });
  expect(projected.actions[2]).toMatchObject({ target: 'unmapped:unknown' });
  expect(projected.abstained).toBe(false);
});
test('errors, omitted offers and unresolved empty outputs cannot become model abstention', () => {
  expect(
    projectGeneration('case', output('no_action'), mapping, true, true),
  ).toMatchObject({ status: 'completed', abstained: true });
  expect(
    projectGeneration('case', output('unknown'), mapping, false).abstained,
  ).toBe(false);
  expect(
    projectGeneration('case', output('unknown'), mapping, true).abstained,
  ).toBe(false);
  for (const outcome of [
    'provider_error',
    'needs_review',
    'proposals',
  ] as const)
    expect(
      projectGeneration('case', output(outcome), mapping, true).abstained,
    ).toBe(false);
  expect(
    projectGeneration(
      'case',
      { ...output('no_action'), omittedSuggestions: 1 },
      mapping,
      true,
    ),
  ).toMatchObject({ status: 'malformed', abstained: false });
});
