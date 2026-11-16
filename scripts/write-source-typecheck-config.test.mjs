import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const writer = fileURLToPath(
  new URL('./write-source-typecheck-config.mjs', import.meta.url),
);

test('the source-check config preserves generated route types and local alias fallbacks', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-typecheck-config-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  function write(file, content) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const kitConfig = '.svelte-kit/tsconfig.json';
  write(kitConfig, JSON.stringify({
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'bundler',
      paths: {
        '$lib/*': ['../src/lib/*', '../overlay/*'],
        '@happyvertical/smrt-ui/i18n': ['../stale.d.ts'],
      },
      rootDirs: ['..', './types'],
      strict: true,
      types: [],
    },
    include: ['../src/routes/*.ts', './types/**/*.d.ts'],
  }));
  write('tsconfig.json', JSON.stringify({ extends: `./${kitConfig}` }));
  write('stale.d.ts', 'export declare function defineMessages(): void;');
  write('overlay/data.ts', 'export const value = "from the overlay";');
  write('.svelte-kit/types/src/routes/$types.d.ts', 'export type Route = string;');
  write('src/routes/+page.ts', `
    import type { Route } from './$types';
    import { value } from '$lib/data';
    import { defineMessages } from '@happyvertical/smrt-ui/i18n';
    const route: Route = value;
    defineMessages({ hello: route });
  `);

  function diagnostics(configFile) {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(fixture, configFile), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(
      ({ code }) => code,
    );
  }

  assert.deepEqual(diagnostics('tsconfig.json'), [2554]);
  const output = '.svelte-kit/tsconfig.typecheck.json';
  const original = readFileSync(join(fixture, kitConfig), 'utf8');
  const generated = spawnSync(process.execPath, [writer, 'tsconfig.json', output], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(diagnostics(output), []);
  assert.equal(readFileSync(join(fixture, kitConfig), 'utf8'), original);
});
