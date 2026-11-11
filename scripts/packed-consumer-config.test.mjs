import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { copyPackedProducerSupportFiles, packedExternalVersions } from './packed-consumer.mjs';

test('isolated producer resolves unselected project references without borrowing their runtime tree', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'smrt-config-copy-'));
  try {
    const root = resolve(fixture, 'root');
    const producer = resolve(fixture, 'producer');
    mkdirSync(resolve(root, 'packages/cli/src'), { recursive: true });
    mkdirSync(resolve(root, 'packages/cli/node_modules'), { recursive: true });
    mkdirSync(producer);
    writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, references: [{ path: './packages/cli' }] }));
    writeFileSync(resolve(root, 'packages/cli/tsconfig.json'), JSON.stringify({ extends: './tsconfig.build.json', include: ['src/*.ts'] }));
    writeFileSync(resolve(root, 'packages/cli/tsconfig.build.json'), JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { composite: true } }));
    writeFileSync(resolve(root, 'packages/cli/src/private.ts'), 'export const hidden = true;');
    copyFileSync(resolve(root, 'tsconfig.json'), resolve(producer, 'tsconfig.json'));
    const referenced = () => ts.createProgram({ rootNames: [], options: {}, projectReferences: [{ path: resolve(producer, 'packages/cli') }] }).getResolvedProjectReferences()?.[0];
    assert.equal(referenced(), undefined, 'baseline lacks the referenced config');
    copyPackedProducerSupportFiles(root, producer);
    const parsed = referenced();
    assert.ok(parsed);
    assert.equal(parsed.commandLine.options.strict, true);
    assert.equal(parsed.commandLine.options.composite, true);
    assert.equal(existsSync(resolve(producer, 'packages/cli/src')), false);
    assert.equal(existsSync(resolve(producer, 'packages/cli/node_modules')), false);
    assert.equal(existsSync(resolve(producer, 'packages/cli/package.json')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('mobile-contract verification gets exact checked-in support files only when selected', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'smrt-mobile-support-'));
  try {
    const root = resolve(fixture, 'root');
    const producer = resolve(fixture, 'producer');
    const contract = 'packages/smrt-mobile/src/commonMain/kotlin/com/happyvertical/smrt/mobile/contract';
    mkdirSync(resolve(root, contract), { recursive: true });
    writeFileSync(resolve(root, contract, 'SupportTypes.kt'), '// exact checked-in proof');
    writeFileSync(resolve(root, 'packages/smrt-mobile/private.kt'), '// not a build input');
    copyPackedProducerSupportFiles(root, producer);
    assert.equal(existsSync(resolve(producer, contract)), false);
    copyPackedProducerSupportFiles(root, producer, ['@happyvertical/smrt-mobile-contract']);
    assert.equal(readFileSync(resolve(producer, contract, 'SupportTypes.kt'), 'utf8'), '// exact checked-in proof');
    assert.equal(existsSync(resolve(producer, 'packages/smrt-mobile/private.kt')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

 test('isolated producer includes the root verifier delegate without the CLI runtime', () => {
 const fixture = mkdtempSync(resolve(tmpdir(), 'smrt-verifier-support-'));
 try {
 const root=resolve(fixture,'root'); const producer=resolve(fixture,'producer');
 const file='packages/cli/scripts/verify-package-types-exports.js';
 mkdirSync(resolve(root,'packages/cli/scripts'),{recursive:true});
 writeFileSync(resolve(root,file),'// exact verifier');
 writeFileSync(resolve(root,'packages/cli/package.json'),'{}');
 copyPackedProducerSupportFiles(root,producer);
 assert.equal(readFileSync(resolve(producer,file),'utf8'),'// exact verifier');
 assert.equal(existsSync(resolve(producer,'packages/cli/package.json')),false);
 } finally { rmSync(fixture,{recursive:true,force:true}); }
 });


test('packed consumers retain different MCP SDK versions for each parent', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'smrt-parent-versions-'));
  try {
    const parents = ['cli', 'smrt-app-mcp'].map(name => {
      const manifest = JSON.parse(readFileSync(resolve(`packages/${name}/package.json`), 'utf8'));
      const dependency = '@modelcontextprotocol/server';
      const resolvedVersion = JSON.parse(readFileSync(resolve(`packages/${name}/node_modules/${dependency}/package.json`), 'utf8')).version;
      const dir = resolve(fixture, name);
      mkdirSync(dir);
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({
        name: manifest.name, version: manifest.version,
        dependencies: { [dependency]: '*' },
      }));
      return { parent: manifest.name, version: manifest.version, dependency, resolvedVersion, dir };
    });
    assert.deepEqual(parents.map(p => p.resolvedVersion), ['2.3.1', '2.4.0']);
    const overrides = packedExternalVersions(parents);
    assert.equal(Object.keys(overrides).length, 2);
    assert.throws(() => packedExternalVersions([...parents, { ...parents[0], resolvedVersion: '0.0.0' }]), /Conflicting external versions/);
    writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ private: true,
      dependencies: Object.fromEntries(parents.map(p => [p.parent, `file:${p.dir}`])),
    }));
    writeFileSync(resolve(fixture, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], overrides }));
    execFileSync('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: fixture, stdio: 'pipe' });
    for (const parent of parents) {
      const require = createRequire(resolve(fixture, 'package.json'));
      const installed = require.resolve(`${parent.parent}/package.json`);
      const parentRequire = createRequire(installed);
      assert.equal(JSON.parse(readFileSync(resolve(parentRequire.resolve(parent.dependency), '../../package.json'), 'utf8')).version, parent.resolvedVersion);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
