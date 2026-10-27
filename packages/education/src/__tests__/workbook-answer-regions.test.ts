import { describe, expect, it } from 'vitest';
import { normalizeWorkbookAnswerRegions } from '../workbook-answer-regions.js';
import type { WorkbookQuestion } from '../workbook-contracts.js';

const sha256 = 'a'.repeat(64);
const questions = [
  { id: 'q1', anchors: [{ assetId: 'asset1', sha256, page: null }] },
] as WorkbookQuestion[];
const sources = [{ assetId: 'asset1', sha256, pageCount: 1 }];
const valid = {
  version: 1,
  provenance: 'observed',
  coordinateSpace: 'display-oriented',
  regions: [
    {
      questionId: 'q1',
      source: { assetId: 'asset1', page: 1 },
      rect: [0.2, 0.3, 0.1, 0.1],
      observationId: 'r1',
    },
  ],
};
describe('workbook answer region presentation', () => {
  it('preserves exact current source/question observed geometry', () =>
    expect(normalizeWorkbookAnswerRegions(valid, questions, sources)).toEqual({
      answerRegions: valid,
    }));
  it('leaves old metadata-less assessments unchanged', () =>
    expect(
      normalizeWorkbookAnswerRegions(undefined, questions, sources),
    ).toEqual({}));
  it.each([
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, provenance: 'verified' },
    ...[
      { questionId: 'foreign' },
      { observationId: '\u0000' },
      { observationId: '\ud800' },
      { source: { assetId: 'foreign', page: 1 } },
      { source: { assetId: 'asset1', page: null } },
      { source: { assetId: 'asset1', page: 2 } },
      { rect: [0, 0, -1, 1] },
      { rect: [0.9, 0, 0.2, 1] },
      { rect: [0, 0, NaN, 1] },
    ].map((fields) => ({
      ...valid,
      regions: [{ ...valid.regions[0], ...fields }],
    })),
    { ...valid, regions: [valid.regions[0], valid.regions[0]] },
  ])('drops invalid optional regions independently %#', (value) => {
    const before = JSON.stringify(questions);
    expect(normalizeWorkbookAnswerRegions(value, questions, sources)).toEqual({
      answerRegionsOmission: 'invalid',
    });
    expect(JSON.stringify(questions)).toBe(before);
  });
  it('rejects old source anchor/hash on a new correction', () =>
    expect(
      normalizeWorkbookAnswerRegions(
        valid,
        [
          {
            ...questions[0],
            anchors: [{ assetId: 'new', sha256, page: null }],
          },
        ] as WorkbookQuestion[],
        sources,
      ),
    ).toEqual({ answerRegionsOmission: 'invalid' }));
});
