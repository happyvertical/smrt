import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { sha256, validateCorpus } from './corpus.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-corpus-'));
  roots.push(root);
  const cases = ['train', 'train', 'train', 'development', 'heldout'].map(
    (partition, index) => {
      const bytes = `Synthetic source ${index}`;
      const path = `${index}.txt`;
      writeFileSync(join(root, path), bytes);
      return {
        id: `case-${index}`,
        group: `family-${index}`,
        partition,
        category: 'draft',
        supported: true,
        expected: [
          {
            kind: 'draft',
            handler: 'create',
            fields: { title: bytes, body: 'Fixture body.' },
          },
        ],
        sources: [
          {
            path,
            sha256: sha256(bytes),
            byteLength: Buffer.byteLength(bytes),
            mediaType: 'text/plain',
          },
        ],
        provenance: {
          author: 'synthetic test',
          generator: 'unit fixture',
          annotation: 'test label',
          adjudication: 'single-author test, not evaluation proof',
        },
      };
    },
  );
  return { root, manifest: { version: 'contract-fixture', cases } };
}
test('valid exact group split and frozen bytes do not imply held-out acceptance', () => {
  const { root, manifest } = fixture();
  expect(validateCorpus(manifest, root)).toMatchObject({
    total: 5,
    counts: { train: 3, development: 1, heldout: 1 },
    minimumHeldoutMet: false,
  });
});
test('tampered bytes, missing provenance, labels and non-group-safe splits fail', () => {
  for (const mutation of [
    (value: ReturnType<typeof fixture>) => {
      writeFileSync(join(value.root, '0.txt'), 'changed');
    },
    (value: ReturnType<typeof fixture>) => {
      value.manifest.cases[4].group = value.manifest.cases[0].group;
    },
    (value: ReturnType<typeof fixture>) => {
      value.manifest.cases[4].sources = value.manifest.cases[0].sources;
    },
    (value: ReturnType<typeof fixture>) => {
      value.manifest.cases[0].provenance.annotation = '';
    },
    (value: ReturnType<typeof fixture>) => {
      value.manifest.cases[0].expected = [];
    },
    (value: ReturnType<typeof fixture>) => {
      value.manifest.cases[4].partition = 'train';
    },
  ]) {
    const fixtureValue = fixture();
    mutation(fixtureValue);
    expect(() =>
      validateCorpus(fixtureValue.manifest, fixtureValue.root),
    ).toThrow();
  }
});
test('source path traversal cannot open files outside the corpus', () => {
  const { root, manifest } = fixture();
  manifest.cases[0].sources[0].path = '../outside.txt';
  expect(() => validateCorpus(manifest, root)).toThrow();
});
test('held-out mandatory subtype coverage cannot be satisfied by train-only cases', () => {
  const { root, manifest } = fixture();
  expect(() =>
    validateCorpus(manifest, root, { requireHeldoutCoverage: true }),
  ).toThrow('subtype');
  Object.assign(manifest.cases[0], {
    coverage: ['unknown_category'],
  });
  expect(() =>
    validateCorpus(manifest, root, { requireHeldoutCoverage: true }),
  ).toThrow('subtype');
});
