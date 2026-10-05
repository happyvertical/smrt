import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { packageManager } = JSON.parse(
  readFileSync(join(repository, 'package.json'), 'utf8'),
);
test('normal build caches cannot restore another producer’s tracked registration source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-turbo-registration-'));
  // Own the cache even when the caller exports a shared TURBO_CACHE_DIR.
  const cacheArgument = `--cache-dir=${join(root, '.turbo/cache')}`;
  const pkg = join(root, 'packages/provider');
  const registration = join(pkg, 'src/lib/server/smrt-register.ts');
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  try {
    write(join(root, 'package.json'), JSON.stringify({ name: 'registration-cache-fixture', private: true, packageManager }));
    write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    write(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/provider: {}\n");
    write(join(root, 'turbo.json'), readFileSync(join(repository, 'turbo.json'), 'utf8'));
    write(join(pkg, 'package.json'), JSON.stringify({ name: 'provider', version: '1.0.0', scripts: { build: 'node build.mjs', typecheck: 'node typecheck.mjs' } }));
    write(join(pkg, 'build.mjs'), "import{existsSync,mkdirSync,writeFileSync}from'node:fs';writeFileSync('.started','');while(!existsSync('.continue'))await new Promise(r=>setTimeout(r,5));mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','export const built = true;');\n");
    // Equivalent to the normal type/config producer after legacy test artifacts
    // gain provenance: runtime registration no longer includes a test provider.
    write(join(pkg, 'typecheck.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('src/lib/server/smrt-register.ts','export const providers = [];\\n');\n");
    write(registration, 'export const providers = [];\n');
    const run = (task) => execFileSync(join(repository, 'node_modules/.bin/turbo'), ['run', task, '--filter=provider', cacheArgument], { cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('pnpm', ['install'], { cwd: root, stdio: 'pipe', timeout: 30000 });
    const child = spawn(join(repository, 'node_modules/.bin/turbo'), ['run', 'build', '--filter=provider', cacheArgument], { cwd: root, stdio: 'inherit' });
    const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))); });
    try {
      const deadline = Date.now() + 15000;
      while (!existsSync(join(pkg, '.started'))) {
        assert.ok(Date.now() < deadline, 'fixture build did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // A different config/type producer can regenerate this tracked source
      // while a library build runs. The library must not cache its bytes.
      write(registration, "export const providers = ['legacy-test-provider'];\n");
      write(join(pkg, '.continue'), '');
      await completed;
    } finally {
      if (child.exitCode === null) child.kill();
    }
    // Normal direct config generation after the test producer gains provenance.
    execFileSync(process.execPath, ['typecheck.mjs'], { cwd: pkg });
    const canonical = readFileSync(registration, 'utf8');
    assert.equal(canonical, 'export const providers = [];\n');
    process.stdout.write(run('build'));
    assert.equal(readFileSync(registration, 'utf8'), canonical);
    run('typecheck');
    const replay = run('build');
    assert.match(replay, /cache hit/);
    assert.equal(readFileSync(registration, 'utf8'), canonical);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
