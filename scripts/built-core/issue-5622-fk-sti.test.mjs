import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '../../packages/core/dist/scanner/manifest-generator.js';

const pkg = '@fk5622/domain.example';
const app = '@fk5622/app';
function definition(packageName, className, extra = {}) {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    collection: `${className.toLowerCase()}s`,
    filePath: `/fixture/${className}.js`,
    extends: 'SmrtObject',
    fields: {},
    methods: {},
    decoratorConfig: {},
    ...extra,
  };
}

test('one built STI artifact migrates then queries in separate production processes (#5622)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-fk5622-'));
  try {
    const objects = [
      definition(pkg, 'Entity', {
        decoratorConfig: { tableStrategy: 'sti', tableName: 'fk5622_entities' },
      }),
      definition(pkg, 'Person', {
        extends: 'Entity',
        extendsQualified: `${pkg}:Entity`,
      }),
      definition(app, 'Subscription', {
        decoratorConfig: { tableName: 'fk5622_subscriptions' },
        fields: {
          personId: {
            type: 'foreignKey',
            related: `${pkg}:Person`,
            _meta: { onDelete: 'CASCADE' },
          },
        },
      }),
    ];
    const artifact = {
      version: '1.0.0',
      timestamp: 0,
      packageName: app,
      objects: Object.fromEntries(
        objects.map((obj) => [obj.qualifiedName, obj]),
      ),
    };
    new ManifestGenerator().applyGenerationPasses(artifact);
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(artifact));
    const original = readFileSync(path, 'utf8');
    const worker = fileURLToPath(
      new URL('./fixtures/issue-5622-process.mjs', import.meta.url),
    );
    const run = (phase, manifestPath = path) => {
      const child = spawnSync(
        process.execPath,
        [worker, phase, manifestPath, join(dir, 'app.db')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'production',
            SMRT_BUILD_MANIFEST: manifestPath,
            SMRT_ALLOW_UNMIGRATED_START: '',
            VITEST: '',
          },
        },
      );
      assert.equal(
        child.status,
        0,
        `${phase}: ${child.stdout}\n${child.stderr}`,
      );
      return JSON.parse(child.stdout.trim().split('\n').at(-1));
    };
    const first = run('migrate');
    assert.equal(first.migrated, true);
    assert.equal(run('query').count, 0);
    const repeated = run('migrate');
    assert.equal(repeated.migrated, false);
    assert.equal(repeated.fingerprint, first.fingerprint);
    assert.equal(run('query').count, 0);
    assert.equal(
      readFileSync(path, 'utf8'),
      original,
      'migrate/runtime must not rewrite the built artifact',
    );
    const changed = JSON.parse(original);
    changed.objects[`${app}:Subscription`].fields.personId._meta.onDelete =
      'RESTRICT';
    new ManifestGenerator().applyGenerationPasses(changed);
    const mismatched = join(dir, 'mismatched.json');
    writeFileSync(mismatched, JSON.stringify(changed));
    assert.equal(run('refuse', mismatched).refused, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
