#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackedConsumer } from './packed-consumer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootRequire = createRequire(import.meta.url);
const fixture = createPackedConsumer({
  root,
  packageNames: ['@happyvertical/smrt-chat'],
  consumerDependencies: {
    vite: JSON.parse(readFileSync(rootRequire.resolve('vite/package.json'), 'utf8'))
      .version,
  },
});
const consumer = fixture.directory;
const require = createRequire(join(consumer, 'package.json'));

try {
  writeFileSync(
    join(consumer, 'consumer.ts'),
    `import {
  HELPER_PREFERENCES_VERSION,
  helperPreferenceFields,
  parseHelperPreferences,
  type HelperClient,
  type HelperPreferences,
} from '@happyvertical/smrt-chat/helper-preferences';

const preferences: HelperPreferences = {
  version: HELPER_PREFERENCES_VERSION,
  offeringId: 'happy',
  name: 'Happy',
  voiceId: 'marin',
  placement: 'bottom-right',
  heardSubtitles: true,
  spokenSubtitles: true,
};
const parsed: HelperPreferences | null = parseHelperPreferences(preferences);
const fields = helperPreferenceFields();
declare const client: HelperClient;
void [parsed, fields, client];
// @ts-expect-error Server services are not browser-subpath exports.
const serverOnly = await import('@happyvertical/smrt-chat/helper-preferences').then(({ HelperPreferencesService }) => HelperPreferencesService);
void serverOnly;
`,
  );
  for (const mode of ['Bundler', 'NodeNext']) {
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
          moduleResolution: mode,
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        files: ['consumer.ts'],
      }),
    );
    fixture.run(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '-p',
      join(consumer, 'tsconfig.json'),
    ]);
    console.log(`Packed helper-preferences consumer: ${mode} passed`);
  }

  writeFileSync(
    join(consumer, 'vite.config.mjs'),
    `import { defineConfig } from 'vite';
export default defineConfig({ build: { lib: { entry: 'browser-entry.ts', formats: ['es'] } } });
`,
  );
  writeFileSync(
    join(consumer, 'browser-entry.ts'),
    `export { helperPreferenceFields, parseHelperPreferences } from '@happyvertical/smrt-chat/helper-preferences';\n`,
  );
  fixture.run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.mjs']);

  writeFileSync(
    join(consumer, 'runtime-check.mjs'),
    `import assert from 'node:assert/strict';
import * as browser from '@happyvertical/smrt-chat/helper-preferences';
assert.equal(browser.HELPER_PREFERENCES_VERSION, 1);
assert.deepEqual(browser.helperPreferenceFields(), [
  'offeringId', 'name', 'voiceId', 'placement', 'heardSubtitles', 'spokenSubtitles',
]);
assert.equal(browser.parseHelperPreferences({
  version: 1, offeringId: 'happy', name: 'Happy', voiceId: 'marin',
  placement: 'bottom-right', heardSubtitles: true, spokenSubtitles: true,
})?.offeringId, 'happy');
assert.equal('HelperPreferencesService' in browser, false);
`,
  );
  fixture.run(process.execPath, ['runtime-check.mjs']);
  console.log('Packed helper-preferences runtime and browser boundary passed');
} finally {
  fixture.cleanup();
}
