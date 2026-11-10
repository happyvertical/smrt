import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/core');

test('core production generator excludes temporary test projects without hiding production models (#4190)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-production-provenance-'));
  try {
    mkdirSync(join(root, 'src/manifest'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/production-provenance', version: '1.0.0', type: 'module' }));
    // Run the real canonical generator in an isolated project. Its implementation
    // dependencies resolve through the links; its discovery and outputs use cwd.
    symlinkSync(join(core, 'src/manifest/generator.ts'), join(root, 'src/manifest/generator.ts'));
    symlinkSync(join(core, 'src/knowledge.ts'), join(root, 'src/knowledge.ts'));
    const models = [
      ['src/contest-production/OrdinaryRecord.ts', 'OrdinaryRecord'],
      ['src/consumer-plugin/__test-ephemeral-431/src/lib/objects/FixtureRecord.ts', 'FixtureRecord'],
      ['src/nested/__test-another-session-982/OtherFixture.ts', 'OtherFixture'],
    ];
    for (const [path, name] of models) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `@smrt()\nexport class ${name} extends SmrtObject { title = ''; }\n`);
    }
    const run = spawnSync(process.execPath, [join(core, 'scripts/generate-manifest.js')], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const content = readFileSync(join(root, 'src/manifest/static-manifest.json'), 'utf8');
    const manifest = JSON.parse(content);
    assert.deepEqual(Object.values(manifest.objects).map((object) => object.className), ['OrdinaryRecord']);
    assert.doesNotMatch(content, /FixtureRecord|OtherFixture|__test-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package verification refuses stale fixture provenance and test artifacts (#4190)', async () => {
  const { verifyProductionManifest } = await import('../packages/core/scripts/verify-production-manifest.js');
  const root = mkdtempSync(join(tmpdir(), 'smrt-packed-provenance-'));
  const path = join(root, 'manifest.json');
  const write = (objects, metadata = {}) => writeFileSync(path, JSON.stringify({ objects, ...metadata }));
  try {
    // Fixture-like class names remain valid when the declaring source is production.
    write({ '@test/pkg:FixtureRecord': { filePath: 'packages/core/src/contest-production/FixtureRecord.ts' } });
    assert.doesNotThrow(() => verifyProductionManifest(path));
    write({});
    assert.doesNotThrow(() => verifyProductionManifest(path));
    for (const source of [
      'packages/core/src/consumer-plugin/__test-ephemeral-431/src/Record.ts',
      'src/nested/__test-different-982/Record.ts',
      'src/__tests__/Record.ts',
      'src/Record.test.ts',
      'src/Record.spec.ts',
      'C:\\project\\src\\__test-windows-104\\Record.ts',
    ]) {
      write({ '@test/pkg:ArbitraryModel': { filePath: source } });
      assert.throws(() => verifyProductionManifest(path), /Test fixture in production manifest: @test\/pkg:ArbitraryModel/);
    }
    write({}, { artifactPurpose: 'test' });
    assert.throws(() => verifyProductionManifest(path), /Invalid production manifest/);
    writeFileSync(path, '{}');
    assert.throws(() => verifyProductionManifest(path), /Invalid production manifest/);
    writeFileSync(path, '{');
    assert.throws(() => verifyProductionManifest(path), SyntaxError);
    rmSync(path);
    assert.throws(() => verifyProductionManifest(path), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
