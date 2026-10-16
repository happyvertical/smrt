import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { copyPackedProducerSupportFiles } from './packed-consumer.mjs';

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
