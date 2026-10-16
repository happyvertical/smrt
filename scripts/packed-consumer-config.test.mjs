import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { copyWorkspaceTypeScriptConfigs } from './packed-consumer.mjs';

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
    copyWorkspaceTypeScriptConfigs(root, producer);
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
