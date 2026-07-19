import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build as viteBuild } from 'vite';
import {
  copyPackageReadmes,
  replaceGeneratedDirectory,
  rewriteLocalLinks,
} from '../docs/scripts/copy-readmes.js';
import {
  hasApplicationManifestRegistration,
  validateQuickstart,
} from './check-readmes.mjs';
import { discoverWorkspaces, validateWorkspaceList } from './workspaces.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'smrt-readmes-'));
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  return root;
}

async function packageFixture(root, name = 'example') {
  const directory = join(root, 'packages', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `{"name":"${name}"}\n`);
  return directory;
}

test('quick start receives semantic TypeScript validation against core exports', async () => {
  const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
  const quickstart = readme.match(
    /<!-- quickstart:start -->\s*```typescript\n([\s\S]*?)\n```\s*<!-- quickstart:end -->/,
  )[1];
  assert.deepEqual(validateQuickstart(quickstart, repoRoot), []);
  assert.match(
    validateQuickstart(quickstart.replace('price: 299.99', "price: 'not a number'"), repoRoot).join(
      '\n',
    ),
    /not assignable to type 'number'/,
  );
  assert.match(
    validateQuickstart(
      quickstart.replace(/ObjectRegistry\.registerPackageManifest\([\s\S]*?\);\n/, ''),
      repoRoot,
    ).join('\n'),
    /does not register the generated application manifest/,
  );
  assert.match(
    validateQuickstart(
      quickstart.replace(
        "new URL('../.smrt/manifest.json', import.meta.url)",
        "new URL(import.meta.url, '../.smrt/manifest.json')",
      ),
      repoRoot,
    ).join('\n'),
    /does not register the generated application manifest/,
  );
  assert.equal(
    hasApplicationManifestRegistration(
      quickstart.replace(
        "new URL('../.smrt/manifest.json', import.meta.url),\n);",
        "new URL('../.smrt/manifest.json', import.meta.url),\n  'extra',\n);",
      ),
    ),
    false,
  );
  assert.match(readme, /pnpm vite build --ssr src\/product\.ts/);
  assert.match(readme, /node dist\/product\.js/);
  assert.doesNotMatch(readme, /pnpm tsx src\/product\.ts/);
});

test('Vite SSR output retains executable application-manifest registration', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const sourceDir = join(root, 'src');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, 'product.ts'),
    [
      "import { ObjectRegistry } from '@happyvertical/smrt-core';",
      'ObjectRegistry.registerPackageManifest(',
      "  new URL('../.smrt/manifest.json', import.meta.url),",
      ');',
      '',
    ].join('\n'),
  );

  await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: 'src/product.ts',
      outDir: 'dist',
      rollupOptions: { external: ['@happyvertical/smrt-core'] },
    },
  });

  const output = await readFile(join(root, 'dist', 'product.js'), 'utf8');
  assert.equal(hasApplicationManifestRegistration(output, 'dist/product.js'), true);
});

test('workspace validation rejects empty, malformed, duplicate, and outside results', async (t) => {
  const root = await fixture();
  const pkg = await packageFixture(root);
  const outside = await mkdtemp(join(tmpdir(), 'smrt-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));

  await assert.rejects(validateWorkspaceList([], root), /exactly one repository-root record/);
  await assert.rejects(
    validateWorkspaceList([{ path: root }, { path: root }, { path: pkg }], root),
    /exactly one repository-root record; received 2/,
  );
  for (const entry of [null, 1, 'path', {}, { path: '' }, { path: 42 }]) {
    await assert.rejects(validateWorkspaceList([{ path: root }, entry], root), /Malformed pnpm workspace result/);
  }
  await assert.rejects(
    validateWorkspaceList([{ path: root }, { path: pkg }, { path: pkg }], root),
    /Duplicate pnpm workspace result/,
  );
  await assert.rejects(validateWorkspaceList([{ path: root }, { path: outside }], root), /outside the repository/);

  const alias = join(root, 'packages', 'alias');
  await symlink(pkg, alias, 'dir');
  await assert.rejects(
    validateWorkspaceList([{ path: root }, { path: pkg }, { path: alias }], root),
    /Duplicate pnpm workspace result/,
  );
  await rm(alias);
  await symlink(outside, alias, 'dir');
  await assert.rejects(validateWorkspaceList([{ path: root }, { path: alias }], root), /outside the repository/);
});

test('workspace discovery fails closed when pnpm only returns the root', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    discoverWorkspaces(root, {
      run: async () => ({ stdout: JSON.stringify([{ path: root }]), stderr: '' }),
    }),
    /zero workspace packages/,
  );
});

test('workspace discovery fails closed when pnpm omits the repository root', async (t) => {
  const root = await fixture();
  const packageDir = await packageFixture(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    discoverWorkspaces(root, {
      run: async () => ({ stdout: JSON.stringify([{ path: packageDir }]), stderr: '' }),
    }),
    /exactly one repository-root record; received 0/,
  );
});

test('README links encode Markdown-significant path bytes and preserve titles', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await packageFixture(root);
  for (const name of ['guide(v1).md', 'open(.md', 'close).md', 'bang!.md', 'what?.md']) {
    await writeFile(join(sourceDir, name), name);
  }
  const source = join(sourceDir, 'README.md');
  await writeFile(source, 'source');
  const markdown =
    '[guide](<./guide(v1).md> "Guide"), [bare](./guide\\(v1\\).md "Bare"), ' +
    '[open](./open\\(.md), [close](./close\\).md), [bang](./bang!.md), [query](./what%3F.md)';

  assert.equal(
    await rewriteLocalLinks(markdown, source, root),
    '[guide](<https://github.com/happyvertical/smrt/blob/main/packages/example/guide%28v1%29.md> "Guide"), [bare](https://github.com/happyvertical/smrt/blob/main/packages/example/guide%28v1%29.md "Bare"), ' +
      '[open](https://github.com/happyvertical/smrt/blob/main/packages/example/open%28.md), [close](https://github.com/happyvertical/smrt/blob/main/packages/example/close%29.md), [bang](https://github.com/happyvertical/smrt/blob/main/packages/example/bang%21.md), [query](https://github.com/happyvertical/smrt/blob/main/packages/example/what%3F.md)',
  );
});

test('README source and local-link symlinks cannot escape the repository', async (t) => {
  const root = await fixture();
  const pkg = await packageFixture(root);
  const outside = await mkdtemp(join(tmpdir(), 'smrt-readme-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, 'outside.md'), 'outside');
  await writeFile(join(pkg, 'README.md'), '[outside](./outside.md)');
  await symlink(join(outside, 'outside.md'), join(pkg, 'outside.md'));
  await assert.rejects(rewriteLocalLinks(await readFile(join(pkg, 'README.md'), 'utf8'), join(pkg, 'README.md'), root), /outside the repository/);

  await rm(join(pkg, 'README.md'));
  await symlink(join(outside, 'outside.md'), join(pkg, 'README.md'));
  const output = join(root, 'docs', 'content', 'packages');
  await mkdir(output, { recursive: true });
  const run = async () => ({ stdout: JSON.stringify([{ path: root }, { path: pkg }]), stderr: '' });
  await assert.rejects(copyPackageReadmes({ repoRoot: root, outputDir: output, run }), /README symlink resolves outside/);
});

test('copying validates all READMEs before replacing generated output', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = await packageFixture(root);
  const output = join(root, 'docs/content/packages');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'sentinel.md'), 'keep me');

  const run = async () => ({ stdout: JSON.stringify([{ path: root }, { path: packageDir }]), stderr: '' });
  await assert.rejects(copyPackageReadmes({ repoRoot: root, outputDir: output, run }), /Unable to read workspace README/);
  assert.equal(await readFile(join(output, 'sentinel.md'), 'utf8'), 'keep me');
});

test('copying publishes only into a canonical in-repository destination', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'smrt-output-outside-'));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  const packageDir = await packageFixture(root);
  await writeFile(join(packageDir, 'README.md'), '# Example\n\nA valid package README.\n');
  const output = join(root, 'docs/content/packages');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'stale.md'), 'stale');
  const run = async () => ({
    stdout: JSON.stringify([{ path: root }, { path: packageDir }]),
    stderr: '',
  });

  assert.equal(await copyPackageReadmes({ repoRoot: root, outputDir: output, run }), 1);
  assert.equal(
    await readFile(join(output, 'example.md'), 'utf8'),
    '# Example\n\nA valid package README.\n',
  );
  await assert.rejects(readFile(join(output, 'stale.md')), /ENOENT/);

  const escapedParent = join(root, 'escaped-docs');
  await symlink(outside, escapedParent, 'dir');
  await assert.rejects(
    copyPackageReadmes({ repoRoot: root, outputDir: join(escapedParent, 'packages'), run }),
    /destination resolves outside the repository/,
  );
});

test('staged replacement swaps output, removes stale files, and cleans its backup', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  const destination = join(root, 'destination');
  const backup = join(root, 'backup');
  await mkdir(staging);
  await mkdir(destination);
  await writeFile(join(staging, 'current.md'), 'current');
  await writeFile(join(destination, 'stale.md'), 'stale');

  await replaceGeneratedDirectory(staging, destination, { backup });
  assert.equal(await readFile(join(destination, 'current.md'), 'utf8'), 'current');
  await assert.rejects(readFile(join(destination, 'stale.md')), /ENOENT/);
  await assert.rejects(readFile(join(backup, 'stale.md')), /ENOENT/);
});

test('rename installation failure rolls the previous output back and preserves the error', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  const destination = join(root, 'destination');
  const backup = join(root, 'backup');
  await mkdir(staging);
  await mkdir(destination);
  await writeFile(join(destination, 'original.md'), 'original');
  const installationError = new Error('install rename failed');
  let calls = 0;
  const renameWithFailure = async (from, to) => {
    calls += 1;
    if (calls === 2) throw installationError;
    return rename(from, to);
  };

  await assert.rejects(
    replaceGeneratedDirectory(staging, destination, { backup, rename: renameWithFailure }),
    (error) => error === installationError,
  );
  assert.equal(await readFile(join(destination, 'original.md'), 'utf8'), 'original');
  assert.equal(calls, 3);
});

test('rollback failure never masks the original installation error', async () => {
  const installationError = new Error('install rename failed');
  const rollbackError = new Error('rollback rename failed');
  let calls = 0;
  const renameWithFailures = async () => {
    calls += 1;
    if (calls === 1) return;
    if (calls === 2) throw installationError;
    throw rollbackError;
  };

  await assert.rejects(
    replaceGeneratedDirectory('/staging', '/destination', {
      backup: '/backup',
      rename: renameWithFailures,
    }),
    (error) => error === installationError && error.rollbackError === rollbackError,
  );
  assert.equal(calls, 3);
});

test('staged replacement without prior output does not perform backup cleanup', async () => {
  const calls = [];
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  let renames = 0;
  await replaceGeneratedDirectory('/staging', '/destination', {
    backup: '/backup',
    rename: async (from, to) => {
      renames += 1;
      calls.push(['rename', from, to]);
      if (renames === 1) throw missing;
    },
    rm: async (...args) => calls.push(['rm', ...args]),
  });
  assert.deepEqual(calls, [
    ['rename', '/destination', '/backup'],
    ['rename', '/staging', '/destination'],
  ]);
});
