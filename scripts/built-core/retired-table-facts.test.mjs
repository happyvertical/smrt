import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRetiredTablesFromPackageJson } from '../../packages/core/dist/migrations.js';
import { ManifestGenerator } from '../../packages/core/dist/scanner/manifest-generator.js';
import {
  loadCore,
  loadReleaseManifests,
  releaseFacts,
  writeDefinition,
  writeOwnersOverlay,
} from '../lib/retired-table-facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const core = await loadCore(root);
const scratch = mkdtempSync(path.join(tmpdir(), 'retired-facts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PKG = '@facts5005/orders';
function manifest(packageName, objects) {
  return JSON.parse(
    JSON.stringify(
      new ManifestGenerator().generateManifest(
        [
          {
            filePath: `/${packageName}`,
            errors: [],
            objects: objects.map((object) => ({
              methods: {},
              decoratorConfig: {},
              packageName,
              extends: 'SmrtObject',
              filePath: `/${packageName}/${object.className}.ts`,
              ...object,
            })),
          },
        ],
        { packageName },
      ),
    ),
  );
}
const ordersManifest = () =>
  manifest(PKG, [
    {
      name: 'orderdraft',
      className: 'OrderDraft',
      collection: 'facts_order_drafts',
      decoratorConfig: { tableName: 'facts_order_drafts' },
      fields: { title: { type: 'text' }, total: { type: 'integer' } },
    },
  ]);

/** A published install: <dir>/<pkg>/package.json and dist/manifest.json. */
function install(name, version, packages) {
  const dir = path.join(scratch, name);
  for (const [packageName, content] of packages) {
    const pkgDir = path.join(dir, 'node_modules', ...packageName.split('/'));
    mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: packageName, version }),
    );
    writeFileSync(path.join(pkgDir, 'dist/manifest.json'), JSON.stringify(content));
  }
  return dir;
}

test("a release's facts: who declared each table, and its columns", () => {
  const facts = releaseFacts(core, [{ packageName: PKG, manifest: ordersManifest() }]);
  assert.deepEqual(facts.owners.facts_order_drafts, [`${PKG}:OrderDraft`]);
  const columns = facts.columns.facts_order_drafts;
  assert.deepEqual(columns.title, { type: 'TEXT' });
  assert.deepEqual(columns.total, { type: 'INTEGER' });
  assert.equal(columns.id.type, 'UUID');
  assert.equal(columns.id.referenceKind, 'id');
  // The registry is left as it was found: empty.
  assert.equal(core.ObjectRegistry.getAllClasses().size, 0);
});

test('reads published manifests from an install and refuses another version', () => {
  const dir = install('install', '1.4.0', [[PKG, ordersManifest()]]);
  const manifests = loadReleaseManifests({ root, release: '1.4.0', from: dir });
  assert.deepEqual(
    manifests.map((item) => item.packageName),
    [PKG],
  );
  assert.throws(
    () => loadReleaseManifests({ root, release: '1.5.0', from: dir }),
    /version 1\.4\.0, not 1\.5\.0/,
  );
});

test('writes a definition core accepts, only for a lastOwner that declared the table', () => {
  const repo = path.join(scratch, 'repo');
  const pkgDir = path.join(repo, 'packages/orders');
  mkdirSync(pkgDir, { recursive: true });
  const declaration = (lastOwner) => ({
    name: PKG,
    version: '1.5.0',
    smrt: {
      retiredTables: [
        {
          table: 'facts_order_drafts',
          lastOwner,
          since: '1.5.0',
          reason: 'Drafts live on the order.',
          rows: 'discard',
        },
      ],
    },
  });
  const facts = releaseFacts(core, [{ packageName: PKG, manifest: ordersManifest() }]);

  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(declaration(`${PKG}:Other`)),
  );
  assert.throws(
    () =>
      writeDefinition({
        root: repo,
        packageName: PKG,
        table: 'facts_order_drafts',
        release: '1.4.0',
        facts,
      }),
    /did not declare facts_order_drafts in release 1\.4\.0/,
  );

  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(declaration(`${PKG}:OrderDraft`)),
  );
  writeDefinition({
    root: repo,
    packageName: PKG,
    table: 'facts_order_drafts',
    release: '1.4.0',
    facts,
  });
  const json = JSON.parse(readFileSync(path.join(pkgDir, 'package.json')));
  const [parsed] = readRetiredTablesFromPackageJson(json, PKG);
  assert.equal(parsed.definition.release, '1.4.0');
  assert.deepEqual(parsed.definition.columns.total, { type: 'INTEGER' });

  assert.throws(
    () =>
      writeDefinition({
        root: repo,
        packageName: PKG,
        table: 'facts_missing',
        release: '1.4.0',
        facts,
      }),
    /declares no retirement of facts_missing/,
  );
});

test('writes an owners file only beside its snapshot, holding its model tables', () => {
  const directory = path.join(scratch, 'gate');
  mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
  assert.throws(
    () => writeOwnersOverlay({ directory, release: '1.4.0', owners: {} }),
    /no snapshot for 1\.4\.0/,
  );
  writeFileSync(
    path.join(directory, 'snapshots/1.4.0.json'),
    JSON.stringify({ release: '1.4.0', tables: {}, modelTables: ['facts_order_drafts'] }),
  );
  const file = writeOwnersOverlay({
    directory,
    release: '1.4.0',
    owners: {
      facts_order_drafts: [`${PKG}:OrderDraft`],
      elsewhere: ['@x/y:Z'],
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(file)), {
    owners: { facts_order_drafts: [`${PKG}:OrderDraft`] },
    release: '1.4.0',
    source: 'published package manifests',
  });
});
