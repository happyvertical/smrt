import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  freezeCaseIdentity,
  logicalIdentity,
  readCaseIdentity,
} from './identity-map.js';

test('pre-call identity map is immutable, hash-bound and exact across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-ids-'));
  const path = join(root, 'identities.json');
  const actual = randomUUID();
  const mapping = {
    caseId: 'authored-case',
    corpusManifestSha256: 'a'.repeat(64),
    entries: [{ logical: 'target-authored-case', actual }],
  };
  try {
    const digest = freezeCaseIdentity(path, mapping);
    expect(() => freezeCaseIdentity(path, mapping)).toThrow();
    const reloaded = readCaseIdentity(path, digest);
    expect(logicalIdentity(reloaded, actual)).toBe('target-authored-case');
    expect(() => logicalIdentity(reloaded, 'target-authored-case')).toThrow(
      'Unmapped',
    );
    expect(() => logicalIdentity(reloaded, randomUUID())).toThrow('Unmapped');
    writeFileSync(path, JSON.stringify({ ...mapping, entries: [] }));
    expect(() => readCaseIdentity(path, digest)).toThrow('Changed frozen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('duplicate actual/logical IDs and non-UUID model text cannot become mappings', () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-ids-invalid-'));
  const actual = randomUUID();
  try {
    for (const entries of [
      [
        { logical: 'one', actual },
        { logical: 'two', actual },
      ],
      [
        { logical: 'one', actual },
        { logical: 'one', actual: randomUUID() },
      ],
      [{ logical: 'one', actual: 'model chose this title' }],
    ])
      expect(() =>
        freezeCaseIdentity(join(root, 'map.json'), {
          caseId: 'case',
          corpusManifestSha256: 'b'.repeat(64),
          entries,
        }),
      ).toThrow('bijection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
