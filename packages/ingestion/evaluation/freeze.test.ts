import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { sha256, validateCorpus } from './corpus.mjs';
import { verifyMaterialization } from './freeze.mjs';
import { SCORING_THRESHOLDS } from './scoring.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
test('preregistered gate constants match the executable scorer', () => {
  const protocol = JSON.parse(
    readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'),
  );
  expect(protocol.thresholds).toEqual(SCORING_THRESHOLDS);
  expect(protocol.confidenceInterval.cluster).toMatchObject({
    seed: 3677,
    replicates: 10000,
  });
});
test('materialization verification binds generator, labels, source bytes and compact index', () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-freeze-'));
  roots.push(root);
  const manifest = {
    version: 'contract-test',
    generatorHash: sha256(
      readFileSync(new URL('./generate-corpus.mjs', import.meta.url)),
    ),
    familyHash: sha256(
      readFileSync(new URL('./corpus/v1/families.json', import.meta.url)),
    ),
    tools: { fixture: 'no-media-provider' },
    cases: ['train', 'train', 'train', 'development', 'heldout'].map(
      (partition, index) => {
        const text = `Source ${index}`;
        const path = `${index}.txt`;
        writeFileSync(join(root, path), text);
        return {
          id: path,
          group: path,
          partition,
          category: 'abstain',
          supported: false,
          expected: [],
          abstainReason: 'contract-test',
          provenance: {
            author: 'test',
            generator: 'test',
            annotation: 'test',
            adjudication: 'test',
          },
          sources: [
            {
              path,
              sha256: sha256(text),
              byteLength: Buffer.byteLength(text),
              mediaType: 'text/plain',
            },
          ],
        };
      },
    ),
  };
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(root, 'manifest.json'), bytes);
  const index = {
    generatorHash: manifest.generatorHash,
    familyHash: manifest.familyHash,
    tools: manifest.tools,
    manifestSha256: sha256(bytes),
    summary: validateCorpus(manifest, root),
    groups: manifest.cases.map((item) => [
      item.group,
      item.partition,
      item.category,
      1,
      sha256(JSON.stringify([item])),
    ]),
  };
  expect(verifyMaterialization(index, root).summary.total).toBe(5);
  expect(() =>
    verifyMaterialization({ ...index, generatorHash: '0'.repeat(64) }, root),
  ).toThrow('generator');
  expect(() => verifyMaterialization({ ...index, groups: [] }, root)).toThrow(
    'index',
  );
  writeFileSync(join(root, '0.txt'), 'tampered');
  expect(() => verifyMaterialization(index, root)).toThrow('hash');
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ ...manifest, version: 'changed-labels' }),
  );
  expect(() => verifyMaterialization(index, root)).toThrow('manifest');
});
