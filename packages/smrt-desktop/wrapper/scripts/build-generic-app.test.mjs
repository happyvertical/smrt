import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appNpmrc,
  BACKDATED_PUBLISH_TIME,
  backdatePackument,
  isInside,
  readWorkspacePackages,
  registryConfig,
  VERDACCIO_VERSION,
  workspaceClosure,
} from './build-generic-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('the closure follows runtime and peer links, never dev dependencies', () => {
  const packages = new Map([
    ['a', { json: { dependencies: { b: '1' }, devDependencies: { dev: '1' } } }],
    ['b', { json: { peerDependencies: { c: '1' } } }],
    ['c', { json: { optionalDependencies: { d: '1' } } }],
    ['d', { json: {} }],
    ['dev', { json: {} }],
    ['unrelated', { json: {} }],
  ]);
  assert.deepEqual(
    workspaceClosure(packages, { devDependencies: { a: '1', external: '1' } }),
    ['a', 'b', 'c', 'd'],
  );
});

test('the real template resolves to workspace packages that can be published', () => {
  const packages = readWorkspacePackages(root);
  const template = JSON.parse(
    readFileSync(
      join(root, 'packages', 'template-sveltekit', 'template', 'package.json'),
      'utf8',
    ),
  );
  const names = workspaceClosure(packages, template);
  for (const required of [
    '@happyvertical/smrt-app-runtime',
    '@happyvertical/smrt-core',
    '@happyvertical/smrt-cli',
  ]) {
    assert.ok(names.includes(required), required);
  }
  for (const name of names) {
    assert.notEqual(packages.get(name).json.private, true, `${name} is private`);
  }
});

test('the registry serves workspace packages locally and never proxies them', () => {
  const config = registryConfig('/tmp/reg');
  const smrt = config.indexOf("'@happyvertical/smrt-*'");
  const rest = config.indexOf("'**'");
  assert.ok(smrt > 0 && rest > smrt);
  assert.ok(!config.slice(smrt, rest).includes('proxy'));
  assert.ok(config.slice(rest).includes('proxy: npmjs'));
  assert.ok(config.includes('publish: $authenticated'));
});

test('the app resolves the default and the scope through the loopback registry', () => {
  assert.equal(
    appNpmrc('http://127.0.0.1:4873/'),
    'registry=http://127.0.0.1:4873/\n@happyvertical:registry=http://127.0.0.1:4873/\n',
  );
});

test('the registry tool is pinned to an exact version', () => {
  assert.match(VERDACCIO_VERSION, /^\d+\.\d+\.\d+$/);
});

test('--out containment is lexical on real paths', () => {
  assert.equal(isInside('/repo', '/repo'), true);
  assert.equal(isInside('/repo', '/repo/out'), true);
  assert.equal(isInside('/repo', '/repository'), false);
  assert.equal(isInside('/repo', '/tmp/out'), false);
});

test('the generic app bundles without the AI provider SDKs and starts', () => {
  // @happyvertical/ai >= 0.111.9 loads openai, @anthropic-ai/sdk and
  // @google/genai only when a provider is created, and smrt-inference reads
  // its constants from `@happyvertical/ai/types`, so the default bundle can
  // drop the SDKs. Enabling `ai-providers` would put them back (about 9 MiB)
  // and a static value import of the `@happyvertical/ai` root in inference
  // would make a bundle without them crash at start.
  const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
  const config = JSON.parse(
    read('packages', 'smrt-desktop', 'examples', 'generic-app', 'smrt-desktop.json'),
  );
  assert.ok(!(config.features?.default ?? []).includes('ai-providers'));
  const inference = join(root, 'packages', 'inference', 'src');
  const stack = [inference];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
        const staticValueImport =
          /^import\s+(?!type\b)[^;]*?from\s+'@happyvertical\/ai';/ms.test(
            readFileSync(path, 'utf8'),
          );
        assert.equal(staticValueImport, false, `${path} imports the @happyvertical/ai root`);
      }
    }
  }
});

test('backdating changes only the publish times', () => {
  const packument = {
    name: 'p',
    versions: { '1.0.0': { name: 'p' } },
    time: { created: '2030-01-01T00:00:00.000Z', '1.0.0': '2030-01-01T00:00:00.000Z' },
  };
  const out = backdatePackument(packument);
  assert.deepEqual(out.versions, packument.versions);
  assert.deepEqual(out.time, {
    created: BACKDATED_PUBLISH_TIME,
    '1.0.0': BACKDATED_PUBLISH_TIME,
  });
  assert.equal(packument.time.created, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(backdatePackument({ name: 'q' }).time, {});
});
