import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const turbo = join(root, 'node_modules/.bin/turbo');
const config = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
const packageManager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
const generated = 'src/types/virtual-modules.d.ts';
const taskNames = ['generate', 'build', 'test', 'typecheck'];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'smrt-turbo-inputs-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  write('package.json', JSON.stringify({ name: 'smrt-input-fixture', private: true, packageManager }));
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/core: {}\n  packages/gnode:\n    dependencies:\n      '@happyvertical/smrt-core':\n        specifier: workspace:*\n        version: link:../core\n");
  write('.gitignore', '.turbo/\n**/dist/\n**/src/types/virtual-modules.d.ts\n');
  for (const name of ['core', 'gnode']) {
    write(`packages/${name}/package.json`, JSON.stringify({
      name: `@happyvertical/smrt-${name}`, private: true,
      ...(name === 'gnode' ? { dependencies: { '@happyvertical/smrt-core': 'workspace:*' } } : {}),
      scripts: {
        build: 'node src/build.mjs', generate: 'node scripts/generate-manifest.js',
        'generate:test': 'node -e ""', test: 'node -e ""', typecheck: 'node -e ""',
      },
    }));
    write(`packages/${name}/src/model.ts`, 'export const model = 1;\n');
    write(`packages/${name}/src/generator.ts`, 'export const generatorVersion = 1;\n');
    write(`packages/${name}/scripts/generate-manifest.js`, '// no-op fixture manifest producer\n');
    write(`packages/${name}/src/build.mjs`, `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.js', 'export const built = true;');
mkdirSync('src/types', {recursive:true});
writeFileSync('${generated}', 'declare module "fixture-virtual" {}\\n');
`);
  }
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', directory]);
  execFileSync('git', ['-C', directory, 'add', '.']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TURBO_')));
  const run = (...args) => execFileSync(turbo, [
    'run', ...args, '--filter=@happyvertical/smrt-gnode', '--no-daemon', '--cache=local:rw',
  ], { cwd: directory, env: { ...env, TURBO_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dry = () => {
    const json = JSON.parse(run(...taskNames, '--dry=json'));
    return Object.fromEntries(json.tasks.filter((task) => task.package === '@happyvertical/smrt-gnode' && taskNames.includes(task.task))
      .map((task) => [task.task, task]));
  };
  return { directory, write, run, dry, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('real Turbo excludes only emitted virtual types while retaining source/generator invalidation', { timeout: 30_000 }, (t) => {
  const f = fixture();
  try {
    const legacy = structuredClone(config);
    for (const name of taskNames) legacy.tasks[name].inputs = legacy.tasks[name].inputs.filter((input) => input !== `!${generated}`);
    legacy.tasks.build.outputs = legacy.tasks.build.outputs.filter((output) => output !== generated);
    f.write('turbo.json', JSON.stringify(legacy));
    const before = f.dry();
    f.write(`packages/gnode/${generated}`, 'declare module "fixture-generated" {}\n');
    const after = f.dry();
    t.diagnostic(`legacy clean→generated: ${taskNames.map((name) => `${name} ${before[name].hash}→${after[name].hash}`).join('; ')}`);
    for (const name of taskNames) {
      assert.notEqual(after[name].hash, before[name].hash, `legacy ${name} must reproduce generated-input drift`);
      assert.ok(Object.hasOwn(after[name].inputs, generated));
    }

    f.write('turbo.json', JSON.stringify(config));
    rmSync(join(f.directory, `packages/gnode/${generated}`));
    const clean = f.dry();
    t.diagnostic(`fixed clean/generated identities: ${taskNames.map((name) => `${name} ${clean[name].hash}`).join('; ')}`);
    for (const content of ['declare module "first" {}\n', 'declare module "changed" {}\n']) {
      f.write(`packages/gnode/${generated}`, content);
      const emitted = f.dry();
      for (const name of taskNames) {
        assert.equal(emitted[name].hash, clean[name].hash, `${name}: generated presence/content must not alter identity`);
        assert.equal(Object.hasOwn(emitted[name].inputs, generated), false);
      }
    }
    f.write('packages/gnode/src/model.ts', 'export const model = 2;\n');
    const changedSource = f.dry();
    for (const name of taskNames) assert.notEqual(changedSource[name].hash, clean[name].hash, `${name}: own source must invalidate`);

    f.write('packages/gnode/src/model.ts', 'export const model = 1;\n');
    f.write('packages/core/src/generator.ts', 'export const generatorVersion = 2;\n');
    const changedGenerator = f.dry();
    for (const name of taskNames) assert.notEqual(changedGenerator[name].hash, clean[name].hash, `${name}: generator dependency build must invalidate`);

    f.write('packages/core/src/generator.ts', 'export const generatorVersion = 1;\n');
    f.write('packages/gnode/src/types/handwritten.d.ts', 'declare module "user-owned" {}\n');
    const changedDeclaration = f.dry();
    for (const name of taskNames) assert.notEqual(changedDeclaration[name].hash, clean[name].hash, `${name}: handwritten declaration must remain an input`);
  } finally {
    f.cleanup();
  }
});

test('a real Turbo build cache hit restores generated virtual declarations', { timeout: 30_000 }, () => {
  const f = fixture();
  try {
    f.write('turbo.json', JSON.stringify(config));
    f.run('build');
    const path = join(f.directory, `packages/gnode/${generated}`);
    const expected = readFileSync(path, 'utf8');
    rmSync(path);
    rmSync(join(f.directory, 'packages/gnode/dist'), { recursive: true });
    const beforeRestore = f.dry();
    assert.equal(beforeRestore.build.cache.status, 'HIT');
    assert.ok(beforeRestore.build.outputs.includes(generated));
    f.run('build');
    assert.equal(readFileSync(path, 'utf8'), expected);
  } finally {
    f.cleanup();
  }
});
