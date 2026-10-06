#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackedConsumer } from './packed-consumer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootRequire = createRequire(import.meta.url);
const fixture = createPackedConsumer({
  root,
  packageNames: ['@happyvertical/smrt-core', '@happyvertical/smrt-assets'],
  evidence: process.env.SMRT_PACKED_EVIDENCE_DIR,
  overrides: process.env.SMRT_PACKED_OVERRIDES
    ? JSON.parse(readFileSync(process.env.SMRT_PACKED_OVERRIDES, 'utf8'))
    : {},
  // Vite is a documented SMRT consumer prerequisite.
  consumerDependencies: { vite: JSON.parse(readFileSync(rootRequire.resolve('vite/package.json'), 'utf8')).version },
});
const consumer = fixture.directory;
const require = createRequire(join(consumer, 'package.json'));
try {
  const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@happyvertical/smrt-assets/dist/manifest.json'), 'utf8'));
  const collection = Object.values(manifest.objects).find((item) => item.className === 'AssetAssociationCollection');
  assert.ok(collection, 'Packed manifest must retain the polymorphic collection');
  assert.equal(collection.extends, 'SmrtJunctionBase');
  const expectedParameters = {
    byLeft: ['metaType', 'metaId', 'opts?'],
    byRight: ['rightId', 'opts?'],
    attach: ['metaType', 'metaId', 'assetId', 'opts?'],
    detach: ['metaType', 'metaId', 'assetId', 'opts?'],
    setLinks: ['metaType', 'metaId', 'assetIds', 'opts?'],
  };
  for (const [method, parameters] of Object.entries(expectedParameters)) {
    assert.deepEqual(collection.methods[method]?.parameters.map((parameter) => parameter.name + (parameter.optional ? '?' : '')), parameters, `Packed generated action parameters: ${method}`);
  }
  writeFileSync(join(consumer, 'consumer.ts'), `import { SmrtJunction, SmrtJunctionBase, type SmrtObject } from '@happyvertical/smrt-core';
import { AssetAssociationCollection, type AssetAssociation } from '@happyvertical/smrt-assets';
declare const composite: AssetAssociationCollection;
declare const ordinary: SmrtJunction<SmrtObject>;
const shared: SmrtJunctionBase<AssetAssociation> = composite;
const inherited = composite.byRight('asset-id');
const loaded = composite.get('link-id');
const attached = composite.attach('owner-type', 'owner-id', 'asset-id');
const expected: Promise<AssetAssociation[]> = inherited;
const expectedItem: Promise<AssetAssociation> = attached;
const expectedGet: Promise<AssetAssociation | null> = loaded;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const noAny: IsAny<Awaited<typeof inherited>[number]> = false;
const noAnyGet: IsAny<Awaited<typeof loaded>> = false;
void composite.byLeft('owner-type', 'owner-id');
void composite.detach('owner-type', 'owner-id', 'asset-id');
void composite.setLinks('owner-type', 'owner-id', ['asset-id']);
void ordinary.attach('owner-id', 'asset-id');
void ordinary.byLeft('owner-id', { tenantId: 'tenant' });
// @ts-expect-error Composite owner cannot omit metaId.
void composite.byLeft('owner-type');
// @ts-expect-error Composite owner cannot use single-owner attach arity.
void composite.attach('owner-id', 'asset-id');
// @ts-expect-error Composite replacement requires both owner arguments.
void composite.setLinks('owner-id', ['asset-id']);
// @ts-expect-error Composite collection is not a single-owner collection.
const invalidBase: SmrtJunction<AssetAssociation> = composite;
// @ts-expect-error Inherited item types must not degrade to any.
const invalidItem: Awaited<typeof inherited>[number] = 'not-an-object';
// @ts-expect-error Single-owner attach cannot accept composite arity.
void ordinary.attach('owner-type', 'owner-id', 'asset-id');
void [shared, expected, expectedItem, expectedGet, noAny, noAnyGet, invalidBase, invalidItem];
`);
  const failedModes = [];
  for (const mode of ['Bundler']) {
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ['node'],
    }, files: ['consumer.ts'] }));
    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) failedModes.push(mode);
    console.log(`Strict packed core/assets consumer: ${mode} ${result.status === 0 ? 'passed' : 'failed'}`);
  }
  assert.equal(failedModes.length, 0, `Strict packed consumer failed: ${failedModes.join(', ')}`);
} finally {
  fixture.cleanup();
}
