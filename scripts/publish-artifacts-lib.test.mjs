import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smrt-publish-artifacts-'));
  const artifacts = join(root, 'artifacts');
  mkdirSync(join(root, '.changeset'), { recursive: true });
  mkdirSync(join(root, 'packages', 'fixture'), { recursive: true });
  mkdirSync(artifacts);
  writeFileSync(
    join(root, '.changeset', 'config.json'),
    JSON.stringify({ fixed: [['@example/fixture']] }),
  );
  writeFileSync(
    join(root, 'packages', 'fixture', 'package.json'),
    JSON.stringify({ name: '@example/fixture', version: '0.1.0' }),
  );
  const filename = 'example-fixture-0.1.0.tgz';
  const tarball = Buffer.from('fixture tarball');
  writeFileSync(join(artifacts, filename), tarball);
  writeFileSync(
    join(artifacts, 'manifest-1-of-1.json'),
    JSON.stringify({
      schemaVersion: 1,
      releaseVersion: '0.1.0',
      packages: [
        {
          name: '@example/fixture',
          version: '0.1.0',
          filename,
          sha256: createHash('sha256').update(tarball).digest('hex'),
        },
      ],
    }),
  );
  return { root, artifacts, filename };
}

test('verifies complete package membership and tarball hashes', () => {
  const { root, artifacts } = fixture();
  try {
    const result = verifyPublishArtifacts(artifacts, root);
    assert.equal(result.releaseVersion, '0.1.0');
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].name, '@example/fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a tarball changed after validation', () => {
  const { root, artifacts, filename } = fixture();
  try {
    writeFileSync(join(artifacts, filename), 'tampered');
    assert.throws(
      () => verifyPublishArtifacts(artifacts, root),
      /SHA-256 mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
