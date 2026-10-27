import { describe, expect, it } from 'vitest';
import type { WorkbookQuestion } from '../workbook-contracts.js';
import { normalizeWorkbookObservedLayout as normalize } from '../workbook-layout.js';

const sources = [
  { assetId: 'image', sha256: 'hash', pageCount: 1 },
  { assetId: 'pdf', sha256: 'pdfhash', pageCount: 3 },
];
const questions = ['a', 'b', 'unplaced'].map((id) => ({
  id,
  anchors: [{ assetId: 'image', sha256: 'hash', page: 1 }],
})) as WorkbookQuestion[];
function layout() {
  return {
    version: 1,
    provenance: 'observed',
    sections: [
      {
        id: 'first',
        label: 'Part A',
        columns: 2,
        readingOrder: 'rows',
        source: { assetId: 'image', page: 1 },
      },
      { id: 'second', columns: 1, source: { assetId: 'pdf', page: null } },
    ],
    placements: [
      { questionId: 'b', sectionId: 'first', row: 0, column: 1, part: 0 },
      { questionId: 'a', sectionId: 'first', row: 0, column: 1, part: 0 },
    ],
  };
}
describe('bounded observed workbook layout', () => {
  it('preserves observed section/placement order, shared cells, ties, and partial placement', () => {
    expect(normalize(layout(), questions, sources)).toEqual({
      layout: layout(),
    });
    expect(normalize(undefined, questions, sources)).toEqual({});
  });
  it('accepts mixed omitted/explicit cell parts without inventing order', () => {
    const value = layout();
    const { part: _part, ...withoutPart } = value.placements[1];
    const mixed = { ...value, placements: [value.placements[0], withoutPart] };
    expect(normalize(mixed, questions, sources)).toEqual({ layout: mixed });
  });
  it('accepts upper bounds and source-only PDF pages without geometry claims', () => {
    const value = {
      version: 1,
      provenance: 'observed',
      sections: Array.from({ length: 32 }, (_, i) => ({
        id: i === 0 ? 's'.repeat(64) : `s${i}`,
        label: 'l'.repeat(200),
        columns: 8,
        readingOrder: 'columns',
        source: { assetId: 'pdf', page: 3 },
      })),
      placements: Array.from({ length: 200 }, (_, i) => ({
        questionId: `q${i}`,
        sectionId: i === 0 ? 's'.repeat(64) : `s${(i % 31) + 1}`,
        row: 199,
        column: 7,
        part: 31,
      })),
    };
    const qs = value.placements.map((p) => ({
      id: p.questionId,
      anchors: [{ assetId: 'pdf', sha256: 'pdfhash', page: null }],
    })) as WorkbookQuestion[];
    expect(normalize(value, qs, sources)).toEqual({ layout: value });
    expect(qs[0].anchors[0].page).toBeNull();
  });
  it('strips unknown metadata at every level without changing questions', () => {
    const value = layout();
    Object.assign(value, { secret: 'raw' });
    Object.assign(value.sections[0], { rect: [1, 2], private: true });
    Object.assign(value.sections[0].source, { uri: 'private' });
    Object.assign(value.placements[0], { raw: 'private' });
    const before = structuredClone(questions);
    expect(normalize(value, questions, sources)).toEqual({ layout: layout() });
    expect(questions).toEqual(before);
  });
  it.each([
    null,
    {},
    [],
    { ...layout(), version: 2 },
    { ...layout(), provenance: 'verified' },
    { ...layout(), sections: Array(33).fill(layout().sections[0]) },
    { ...layout(), placements: Array(201).fill(layout().placements[0]) },
    { ...layout(), sections: [layout().sections[0], layout().sections[0]] },
    {
      ...layout(),
      placements: [layout().placements[0], layout().placements[0]],
    },
    ...[-1, 200, 1.5].map((row) => ({
      ...layout(),
      placements: [{ ...layout().placements[0], row }],
    })),
    ...[-1, 2, 1.5].map((column) => ({
      ...layout(),
      placements: [{ ...layout().placements[0], column }],
    })),
    ...[-1, 32, 0.5].map((part) => ({
      ...layout(),
      placements: [{ ...layout().placements[0], part }],
    })),
    ...[0, 9, 1.5].map((columns) => ({
      ...layout(),
      sections: [{ ...layout().sections[0], columns }],
    })),
    {
      ...layout(),
      sections: [{ ...layout().sections[0], id: 'x'.repeat(65) }],
    },
    {
      ...layout(),
      sections: [{ ...layout().sections[0], label: 'x'.repeat(201) }],
    },
    {
      ...layout(),
      sections: [{ ...layout().sections[0], readingOrder: 'diagonal' }],
    },
    {
      ...layout(),
      sections: [
        { ...layout().sections[0], source: { assetId: 'foreign', page: 1 } },
      ],
    },
    {
      ...layout(),
      sections: [
        { ...layout().sections[0], source: { assetId: 'image', page: 2 } },
      ],
    },
    {
      ...layout(),
      placements: [{ ...layout().placements[0], questionId: 'unknown' }],
    },
    {
      ...layout(),
      placements: [{ ...layout().placements[0], sectionId: 'unknown' }],
    },
  ])('omits invalid metadata only: %j', (value) => {
    expect(normalize(value, questions, sources)).toEqual({
      layoutOmission: 'invalid',
    });
  });
  it('requires each question to anchor the section source, hash, and observed page', () => {
    const value = layout();
    value.sections[0].source = { assetId: 'pdf', page: 2 };
    expect(normalize(value, questions, sources)).toEqual({
      layoutOmission: 'invalid',
    });
    const pdfQuestions = questions.map((q) => ({
      ...q,
      anchors: [{ assetId: 'pdf', sha256: 'pdfhash', page: null }],
    })) as WorkbookQuestion[];
    expect(normalize(value, pdfQuestions, sources)).toEqual({ layout: value });
    value.sections[0].source.page = 4;
    expect(normalize(value, pdfQuestions, sources)).toEqual({
      layoutOmission: 'invalid',
    });
    const wrongPage = pdfQuestions.map((q) => ({
      ...q,
      anchors: q.anchors.map((a) => ({ ...a, page: 1 })),
    }));
    value.sections[0].source.page = 2;
    expect(normalize(value, wrongPage, sources)).toEqual({
      layoutOmission: 'invalid',
    });
    const badHash = questions.map((q) => ({
      ...q,
      anchors: q.anchors.map((a) => ({ ...a, sha256: 'wrong' })),
    }));
    expect(normalize(layout(), badHash, sources)).toEqual({
      layoutOmission: 'invalid',
    });
  });
});
