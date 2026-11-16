import assert from 'node:assert/strict';
import {
  copyFileSync,
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

const root = fileURLToPath(new URL('../', import.meta.url));
const users = 'packages/users';
const ui = 'packages/smrt-ui';

test('the users typecheck reads the current UI i18n export with stale or missing declarations', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-source-check-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  for (const file of [
    'tsconfig.json',
    'tsconfig.package-build.json',
    'tsconfig.package-typecheck.json',
    'tsconfig.ui-package.json',
    'tsconfig.workspace-source-paths.json',
    `${users}/tsconfig.json`,
    `${users}/tsconfig.svelte.json`,
    `${users}/tsconfig.svelte-typecheck.json`,
    `${users}/tsconfig.typecheck.json`,
    `${users}/src/svelte/i18n.ts`,
  ]) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }

  const installedUi = join(fixture, 'node_modules/@happyvertical/smrt-ui');
  const declarations = join(installedUi, 'dist');
  mkdirSync(join(declarations, 'i18n'), { recursive: true });
  copyFileSync(join(root, ui, 'package.json'), join(installedUi, 'package.json'));
  writeFileSync(
    join(declarations, 'i18n/index.d.ts'),
    'export declare function defineMessages<T>(messages: T): T;',
  );

  const source = join(fixture, ui, 'src/i18n/index.ts');
  mkdirSync(dirname(source), { recursive: true });
  const publicApi =
    'export function defineMessages<T>(messages: T): T { return messages; }';
  writeFileSync(source, publicApi);

  const { scripts } = JSON.parse(
    readFileSync(join(root, users, 'package.json'), 'utf8'),
  );
  const tsconfig =
    scripts.typecheck.match(/\btsc\b[^&]*\s-p\s+(\S+)/)?.[1] ?? 'tsconfig.json';
  const svelteConfig = scripts.typecheck.match(/--tsconfig\s+(\S+)/)?.[1];
  assert.ok(svelteConfig, 'users typecheck also runs svelte-check');
  const configs = [tsconfig, svelteConfig];

  function check(configName) {
    const path = join(fixture, users, configName);
    const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(error, undefined);
    // The fixture only exercises a TypeScript import. Ambient Node and Svelte
    // types belong to the full package check and need no fixture copies.
    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      dirname(path),
      { types: [] },
      path,
    );
    assert.deepEqual(parsed.errors, []);
    return ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
  }

  function expectMissingExport() {
    for (const config of configs) {
      const errors = check(config);
      assert.deepEqual(errors.map((error) => error.code), [2305], config);
      assert.match(errors[0].messageText, /no exported member 'defineMessages'/);
    }
  }

  for (const config of configs) assert.deepEqual(check(config), []);
  writeFileSync(source, publicApi.replace('defineMessages', 'registerMessages'));
  expectMissingExport();
  rmSync(declarations, { recursive: true });
  expectMissingExport();
  writeFileSync(source, publicApi);
  for (const config of configs) assert.deepEqual(check(config), []);
});
