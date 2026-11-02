import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANARY_PACKAGES,
  FIXTURE,
  checkMigrationStatus,
  consumerManifests,
  parseArgs,
  workspacePin,
  yamlBlock,
} from './release-consumer-canary.mjs';

// Issue #2975. The canary itself (install, build, register, typecheck, test,
// migrate against real tarballs) runs in the planner release gate on every
// release candidate and merge-group dry run; these tests pin how it composes
// the consumer so it keeps installing the release, not the registry.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaceYaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const template = JSON.parse(
  readFileSync(join(FIXTURE, 'package.template.json'), 'utf8'),
);

function releaseTarballs(extra = []) {
  return new Map(
    [
      ...CANARY_PACKAGES.dependencies,
      ...CANARY_PACKAGES.devDependencies,
      '@happyvertical/smrt-tenancy',
      ...extra,
    ].map((name) => [name, `/packs/${name.replace('/', '-')}.tgz`]),
  );
}

test('installs the canary packages from the release tarballs and overrides every release package', () => {
  const tarballs = releaseTarballs();
  const { packageJson, workspaceYaml: consumerYaml } = consumerManifests({
    tarballs,
    rootPackageJson,
    workspaceYaml,
    template,
  });

  for (const name of CANARY_PACKAGES.dependencies) {
    assert.equal(packageJson.dependencies[name], `file:${tarballs.get(name)}`);
  }
  for (const name of CANARY_PACKAGES.devDependencies) {
    assert.equal(packageJson.devDependencies[name], `file:${tarballs.get(name)}`);
  }
  // A transitive release package (tenancy, via tags) resolves to its tarball
  // too, never to whatever the registry holds at that version.
  for (const [name, path] of tarballs) {
    assert.match(consumerYaml, new RegExp(`^  '${name}': 'file:${path}'$`, 'm'));
  }
});

test('pins tools to the repository versions and approves the same install scripts', () => {
  const { packageJson, workspaceYaml: consumerYaml } = consumerManifests({
    tarballs: releaseTarballs(),
    rootPackageJson,
    workspaceYaml,
    template,
  });

  assert.equal(packageJson.packageManager, rootPackageJson.packageManager);
  for (const tool of ['typescript', 'vite', 'vitest']) {
    assert.equal(packageJson.devDependencies[tool], rootPackageJson.devDependencies[tool]);
  }
  assert.equal(
    packageJson.devDependencies['@types/node'],
    workspacePin(workspaceYaml, '@types/node'),
  );
  assert.ok(packageJson.devDependencies['@types/node']);
  const approved = yamlBlock(workspaceYaml, 'allowBuilds');
  assert.ok(approved.some((line) => line.startsWith('  esbuild:')));
  assert.ok(consumerYaml.includes(['allowBuilds:', ...approved].join('\n')));
  assert.equal(packageJson.scripts.build, 'vite build');
});

test('refuses a release that lacks a package the canary installs', () => {
  const tarballs = releaseTarballs();
  tarballs.delete('@happyvertical/smrt-vitest');
  assert.throws(
    () => consumerManifests({ tarballs, rootPackageJson, workspaceYaml, template }),
    /release packs lack @happyvertical\/smrt-vitest/,
  );
});

test('reads workspace pins and top-level YAML blocks', () => {
  const yaml = "catalog:\n  '@types/node': 24.1.0\n  vite: ^8.0.0\n\nallowBuilds:\n  esbuild: true\n  sharp: true\n\nother:\n  x: 1\n";
  assert.equal(workspacePin(yaml, '@types/node'), '24.1.0');
  assert.equal(workspacePin(yaml, 'vite'), '^8.0.0');
  assert.equal(workspacePin(yaml, 'missing'), undefined);
  assert.deepEqual(yamlBlock(yaml, 'allowBuilds'), ['  esbuild: true', '  sharp: true']);
  assert.deepEqual(yamlBlock(yaml, 'absent'), []);
});

test('requires --packs', () => {
  assert.throws(() => parseArgs([]), /--packs/);
  assert.deepEqual(parseArgs(['--packs', 'dir', '--keep']), { packs: 'dir', keep: true });
  assert.throws(() => parseArgs(['--packs=dir', '--nope']), /unknown argument/);
});

test('the fixture is a consumer-shaped app: its own model, a consumed package, generated registration', () => {
  for (const file of [
    'package.template.json',
    'vite.config.ts',
    'vitest.config.ts',
    'tsconfig.json',
    'smrt.config.js',
    'register-probe.mjs',
    'src/index.ts',
    'src/models/tree-node.ts',
    'src/registry-probe.spec.ts',
  ]) {
    assert.ok(existsSync(join(FIXTURE, file)), file);
  }
  const vite = readFileSync(join(FIXTURE, 'vite.config.ts'), 'utf8');
  assert.match(vite, /smrtConsumer\(/);
  assert.match(vite, /'@happyvertical\/smrt-tags'/);
  const spec = readFileSync(join(FIXTURE, 'src/registry-probe.spec.ts'), 'utf8');
  assert.match(spec, /\.smrt\/register\.js/);
  assert.doesNotMatch(spec, /models\/tree-node/);
});

test('the planner release gate runs the canary as a framework check', () => {
  const gate = readFileSync(join(root, 'scripts/planner-release-gate.mjs'), 'utf8');
  assert.match(gate, /import \{ runReleaseConsumerCanary \} from '\.\/release-consumer-canary\.mjs'/);
  assert.match(gate, /owner: 'framework',[\s\S]{0,800}run: \(\) => runReleaseConsumerCanary\(\{ tarballs \}\)/);
});

test('inherits the repository third-party overrides and release-age exclusions, never its workspace links', () => {
  const { workspaceYaml: consumerYaml } = consumerManifests({
    tarballs: releaseTarballs(),
    rootPackageJson,
    workspaceYaml,
    template,
  });
  const overrides = yamlBlock(consumerYaml, 'overrides');
  assert.ok(overrides.some((line) => line.startsWith("  '@types/node':")));
  assert.ok(overrides.some((line) => /^ {2}'?follow-redirects@/.test(line)));
  assert.ok(!overrides.some((line) => line.includes('workspace:')));
  const smrt = overrides.filter((line) => line.includes('@happyvertical/smrt-'));
  assert.ok(smrt.length > 0 && smrt.every((line) => line.includes("': 'file:")));
  assert.deepEqual(
    yamlBlock(consumerYaml, 'minimumReleaseAgeExclude'),
    yamlBlock(workspaceYaml, 'minimumReleaseAgeExclude'),
  );
});

function status(overrides = {}) {
  return {
    drift: [],
    schemaContract: { ok: true },
    migrations: {
      failed: { total: 0 },
      details: ['tag_aliases', 'tags', 'tree_nodes'].map((table) => ({
        name: `create_table_${table}`,
      })),
    },
    manifests: {
      details: [
        { objectNames: ['@happyvertical/smrt-tags:Tag'] },
        { objectNames: ['TreeNode'] },
      ],
    },
    ...overrides,
  };
}

test('db:status must show the expected tables migrated with no drift', () => {
  assert.ok(checkMigrationStatus(`[smrt] log line\n${JSON.stringify(status())}`));
  assert.throws(
    () => checkMigrationStatus(JSON.stringify(status({ drift: [{ table: 'tags' }] }))),
    /drift/,
  );
  assert.throws(
    () =>
      checkMigrationStatus(
        JSON.stringify(status({ migrations: { failed: { total: 0 }, details: [] } })),
      ),
    /no applied create_table_tags migration/,
  );
  assert.throws(
    () => checkMigrationStatus(JSON.stringify(status({ manifests: { details: [] } }))),
    /manifests do not list Tag/,
  );
  assert.throws(() => checkMigrationStatus('no json'), /printed no JSON/);
});
