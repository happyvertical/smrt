import { expect, test } from 'vitest';
import { rate, scoreCases, scoreStrata } from './scoring.mjs';

const profile = {
  provider: 'injected-contract-test',
  model: 'no-inference',
  runDigest: 'a'.repeat(64),
};
const safety = {
  authorityViolations: 0,
  unauthorizedDisclosures: 0,
  duplicateEffects: 0,
  automaticEffects: 0,
};
const draft = {
  kind: 'draft',
  handler: 'create',
  fields: { title: 'Title', body: 'Exact body.' },
};
const attachment = {
  kind: 'attachment',
  handler: 'attach',
  target: 'authorized',
  fields: { contentId: 'authorized' },
};
const cases = [
  {
    id: 'draft',
    group: 'draft-family',
    partition: 'heldout',
    category: 'draft',
    supported: true,
    expected: [draft],
    sources: [{ mediaType: 'text/plain' }],
  },
  {
    id: 'attachment',
    group: 'attachment-family',
    partition: 'heldout',
    category: 'attachment',
    supported: true,
    expected: [attachment],
    sources: [{ mediaType: 'image/png' }],
  },
  {
    id: 'unsafe',
    group: 'unsafe-family',
    partition: 'heldout',
    category: 'abstain',
    supported: false,
    expected: [],
    sources: [{ mediaType: 'audio/wav' }],
  },
];
const result = (id: string, actions: unknown[] = [], abstained = false) => ({
  id,
  status: 'completed',
  actions,
  abstained,
  safety,
  latencyMs: 10,
  fallback: false,
  correctionEdits: 0,
});
test('exact correct outcomes retain denominators, unknown costs and family-level summaries without acceptance inflation', () => {
  const report = scoreCases(
    cases,
    [
      result('draft', [draft]),
      result('attachment', [attachment]),
      result('unsafe', [], true),
    ],
    profile,
  );
  for (const metric of Object.values(report.metrics) as { estimate: number }[])
    expect(metric.estimate).toBe(1);
  expect(report.primaryUncertainty.families).toHaveLength(3);
  expect(report.primaryUncertainty.ranges.draftPrecision.families).toBe(1);
  expect(report.minimumHeldoutMet).toBe(false);
  expect(report.automationEligible).toBe(false);
  expect(report.charge).toEqual({ verifiedNanoUSD: 0, unknownCases: 3 });
  expect(report.latency).toEqual({
    measured: 3,
    unknown: 0,
    p50Ms: 10,
    p95Ms: 10,
  });
});
test('missing/provider-failed/budget-refused cases remain in intended denominator, never count as abstention', () => {
  const report = scoreCases(
    cases,
    [
      { id: 'draft', status: 'provider_failure' },
      { id: 'unsafe', status: 'budget_refused' },
    ],
    profile,
  );
  expect(report.metrics.requiredFields).toMatchObject({
    successes: 0,
    denominator: 1,
  });
  expect(report.metrics.draftRecall.estimate).toBe(0);
  expect(report.metrics.attachmentRecall.estimate).toBe(0);
  expect(report.metrics.abstention.estimate).toBe(0);
  expect(report.metrics.draftPrecision.estimate).toBeNull();
  expect(report.failureRate.estimate).toBe(1);
  expect(report.safety.unknownCases).toBe(3);
});
test('wrong targets, extra actions and altered required fields are scored separately', () => {
  const report = scoreCases(
    cases,
    [
      result('draft', [
        { ...draft, fields: { ...draft.fields, body: 'Different.' } },
        draft,
      ]),
      result('attachment', [{ ...attachment, target: 'other-tenant' }]),
      result('unsafe', [draft]),
    ],
    profile,
  );
  expect(report.metrics.draftPrecision).toMatchObject({
    successes: 1,
    denominator: 3,
  });
  expect(report.metrics.attachmentPrecision.estimate).toBe(0);
  expect(report.metrics.abstention.estimate).toBe(0);
  expect(report.metrics.requiredFields.denominator).toBe(1);
});
test('only explicitly permitted normalization applies, fields cannot be invented or trimmed', () => {
  const source = {
    ...cases[0],
    expected: [{ ...draft, fields: { title: 'café', body: 'a\nb' } }],
  };
  expect(
    scoreCases(
      [source],
      [
        result('draft', [
          { ...draft, fields: { title: 'cafe\u0301', body: 'a\r\nb' } },
        ]),
      ],
      profile,
    ).metrics.requiredFields.estimate,
  ).toBe(1);
  expect(
    scoreCases(
      [source],
      [
        result('draft', [
          { ...draft, fields: { title: ' café', body: 'a\nb' } },
        ]),
      ],
      profile,
    ).metrics.requiredFields.estimate,
  ).toBe(0);
});
test('multi-label matching consumes each offered action at most once', () => {
  const source = { ...cases[0], expected: [draft, draft] };
  const report = scoreCases([source], [result('draft', [draft])], profile);
  expect(report.metrics.draftRecall).toMatchObject({
    successes: 1,
    denominator: 2,
  });
  expect(report.metrics.requiredFields).toMatchObject({
    successes: 1,
    denominator: 2,
  });
});
test('foreign, duplicate, contradictory, malformed and unknown results cannot silently disappear', () => {
  for (const values of [
    [result('foreign')],
    [result('draft'), result('draft')],
    [{ id: 'draft', status: 'new-status' }],
    [result('draft', [draft], true)],
    [{ id: 'draft', status: 'provider_failure', abstained: true }],
  ])
    expect(() => scoreCases(cases, values, profile)).toThrow();
  expect(() => scoreCases(cases, [], {})).toThrow();
});
test('nominal case Wilson endpoints and no-data cases are explicit', () => {
  expect(rate(0, 0).interval95).toBeNull();
  expect(rate(95, 100).interval95?.[0]).toBeCloseTo(0.88825, 4);
  expect(rate(100, 100).interval95?.[1]).toBeCloseTo(1);
  expect(() => rate(2, 1)).toThrow();
});
test('cluster intervals use whole families, fixed resampling and explicit undefined ratios', () => {
  const other = { ...cases[0], id: 'other-draft', group: 'other-family' };
  const input = [cases[0], other];
  const outcomes = [result('draft', [draft]), result('other-draft', [], true)];
  const first = scoreCases(input, outcomes, profile);
  const second = scoreCases(input, outcomes, profile);
  expect(first.clusterIntervals).toEqual(second.clusterIntervals);
  expect(first.clusterIntervals.draftRecall.interval95).toEqual([0, 1]);
  expect(first.clusterIntervals.attachmentRecall).toMatchObject({
    interval95: null,
    definedReplicates: 0,
    undefinedReplicates: 10000,
  });
  expect(
    first.clusterIntervals.draftPrecision.undefinedReplicates,
  ).toBeGreaterThan(0);
  expect(first.primaryUncertainty.ranges.draftRecall.families).toBe(2);
});
test('field matching is stable for reversed distinct offers and a wrong-field duplicate', () => {
  const other = { ...draft, fields: { title: 'Other', body: 'Other body.' } };
  const source = { ...cases[0], expected: [draft, other] };
  const report = scoreCases(
    [source],
    [result('draft', [{ ...draft, fields: { title: 'Wrong' } }, other, draft])],
    profile,
  );
  expect(report.metrics.requiredFields).toMatchObject({
    successes: 2,
    denominator: 2,
  });
  expect(report.metrics.draftPrecision).toMatchObject({
    successes: 2,
    denominator: 3,
  });
});
test('only verified specific structural dispositions count as system abstention, never generic errors', () => {
  const source = {
    ...cases[2],
    lane: 'deterministic-fault',
    systemAbstentionReason: 'corrupt_source',
    sources: [{ mediaType: 'application/pdf', sha256: 'c'.repeat(64) }],
  };
  const disposition = {
    owner: 'IngestionService',
    attemptId: 'current-attempt',
    state: 'failed',
    inputDigest: 'd'.repeat(64),
    outputDigest: 'e'.repeat(64),
    sourceHashes: ['c'.repeat(64)],
    reason: 'corrupt_source',
    eligibleProposalCount: 0,
    actionCount: 0,
    verification: 'persisted-state-and-provenance',
  };
  const prediction = {
    id: 'unsafe',
    status: 'structural_abstention',
    modelInvoked: false,
    disposition,
  };
  const report = scoreCases([source], [prediction], profile);
  expect(report.metrics.abstention.estimate).toBe(1);
  expect(report.structuralAbstentions).toBe(1);
  expect(report.modelAbstention.denominator).toBe(0);
  expect(report.noModelCallCoverage.verifiedNoCall).toBe(1);
  const failed = scoreCases(
    [source],
    [{ id: 'unsafe', status: 'provider_failure', modelInvoked: false }],
    profile,
  );
  expect(failed.metrics.abstention.estimate).toBe(0);
  expect(failed.failureRate.estimate).toBe(1);
  for (const changes of [
    { reason: 'provider_failure' },
    { sourceHashes: ['f'.repeat(64)] },
    { eligibleProposalCount: 1 },
    { actionCount: 1 },
    { verification: 'assumed' },
  ])
    expect(() =>
      scoreCases(
        [source],
        [{ ...prediction, disposition: { ...disposition, ...changes } }],
        profile,
      ),
    ).toThrow('Unproven');
  expect(() => scoreCases([cases[2]], [prediction], profile)).toThrow(
    'Unproven',
  );
});

test('descriptive media/action/subtype strata retain missing failures without filtering denominators', () => {
  const rows = cases.map((row) => ({
    ...row,
    coverage: [row.id === 'unsafe' ? 'unreadable' : 'supported'],
  }));
  const report = scoreStrata(rows, [result('draft', [draft])], profile);
  expect(report.media['text/plain']).toMatchObject({
    intendedCases: 1,
    completedCases: 1,
    families: 1,
  });
  expect(report.media['audio/wav'].failureRate).toMatchObject({
    successes: 1,
    denominator: 1,
  });
  expect(report.action.attachment.completedCases).toBe(0);
  expect(report.subtype.supported).toMatchObject({
    intendedCases: 2,
    completedCases: 1,
  });
  expect(report.subtype.unreadable.metrics.abstention).toMatchObject({
    successes: 0,
    denominator: 1,
  });
});

test('known duplicate observations fail safety even when other counters remain unknown', () => {
  const score = scoreCases(
    cases,
    [
      {
        id: 'draft',
        status: 'completed',
        actions: [draft],
        abstained: false,
        safety: { duplicateEffects: 1 },
      },
    ],
    profile,
  );
  expect(score.safety.observed.duplicateEffects).toBe(1);
  expect(score.safety.gateStatus).toBe('fail');
  expect(score.safety.unknownCases).toBeGreaterThan(0);
  expect(score.metrics.draftPrecision.denominator).toBe(1);
});
