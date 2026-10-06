#!/usr/bin/env node
// Build the workspace first; install only public files from real package tarballs.
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
  packageNames: ['@happyvertical/smrt-core', '@happyvertical/smrt-profiles', '@happyvertical/smrt-inventory'],
  evidence: process.env.SMRT_PACKED_EVIDENCE_DIR,
  overrides: process.env.SMRT_PACKED_OVERRIDES
    ? JSON.parse(readFileSync(process.env.SMRT_PACKED_OVERRIDES, 'utf8'))
    : {},
  // PROJECT_REQUIREMENTS.md requires Vite in consumer projects.
  consumerDependencies: { vite: JSON.parse(readFileSync(rootRequire.resolve('vite/package.json'), 'utf8')).version },
});
const consumer = fixture.directory;
const require = createRequire(join(consumer, 'package.json'));
try {
  writeFileSync(join(consumer, 'consumer.ts'), `import { SmrtCollection, type SmrtObject } from '@happyvertical/smrt-core';
import { ProfileCollection, type Profile } from '@happyvertical/smrt-profiles';
import { StockLevelCollection, type StockLevel } from '@happyvertical/smrt-inventory';
declare const core: SmrtCollection<SmrtObject>;
declare const profiles: ProfileCollection;
declare const stock: StockLevelCollection;
const coreResult = core.get('00000000-0000-4000-8000-000000000001');
const profileResult = profiles.get('00000000-0000-4000-8000-000000000001');
const stockResult = stock.get('00000000-0000-4000-8000-000000000001');
const expectedCore: Promise<SmrtObject | null> = coreResult;
const expectedProfile: Promise<Profile | null> = profileResult;
const expectedStock: Promise<StockLevel | null> = stockResult;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const coreAny: IsAny<Awaited<typeof coreResult>> = false;
const profileAny: IsAny<Awaited<typeof profileResult>> = false;
const stockAny: IsAny<Awaited<typeof stockResult>> = false;
// @ts-expect-error A string must not be accepted through an unresolved inherited method.
const invalidCore: Awaited<typeof coreResult> = 'not-an-object';
// @ts-expect-error A string must not be accepted through an unresolved inherited method.
const invalidStock: Awaited<typeof stockResult> = 'not-a-stock-level';
const level = await stockResult;
if (level) {
  const quantity: number = level.qty;
  // @ts-expect-error Persisted quantity retains its numeric public type.
  const invalidQuantity: string = level.qty;
  void [quantity, invalidQuantity];
}
void [expectedCore, expectedProfile, expectedStock, coreAny, profileAny, stockAny, invalidCore, invalidStock];
`);
  const failedModes = [];
  for (const mode of ['Bundler', 'NodeNext']) {
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ['node'],
    }, files: ['consumer.ts'] }));
    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) failedModes.push(mode);
    console.log(`Strict packed core/profiles/inventory consumer: ${mode} ${result.status === 0 ? 'passed' : 'failed'}`);
  }
  assert.equal(failedModes.length, 0, `Strict packed consumer failed: ${failedModes.join(', ')}`);
} finally {
  fixture.cleanup();
}
