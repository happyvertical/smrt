import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRetiredTablesFromPackageJson } from '../../packages/core/dist/migrations.js';
import { ManifestGenerator } from '../../packages/core/dist/scanner/manifest-generator.js';
import {
  checkRetiredFacts,
  loadCheckoutManifests,
  loadCore,
  loadReleaseManifests,
  refreshRetiredFacts,
  releaseFacts,
  verifyRetiredFactsOnline,
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
  const read = () => {
    const json = JSON.parse(readFileSync(path.join(pkgDir, 'package.json')));
    return readRetiredTablesFromPackageJson(json, PKG)[0];
  };
  let parsed = read();
  assert.equal(parsed.definitions.length, 1);
  assert.equal(parsed.definitions[0].release, '1.4.0');
  assert.deepEqual(parsed.definitions[0].columns.total, { type: 'INTEGER' });

  // One definition per release: an older release's shape joins it, in
  // release order, and writing a release again replaces only its own.
  const older = releaseFacts(core, [
    {
      packageName: PKG,
      manifest: manifest(PKG, [
        {
          name: 'orderdraft',
          className: 'OrderDraft',
          collection: 'facts_order_drafts',
          decoratorConfig: { tableName: 'facts_order_drafts' },
          fields: { title: { type: 'text' } },
        },
      ]),
    },
  ]);
  writeDefinition({
    root: repo,
    packageName: PKG,
    table: 'facts_order_drafts',
    release: '1.3.0',
    facts: older,
  });
  writeDefinition({
    root: repo,
    packageName: PKG,
    table: 'facts_order_drafts',
    release: '1.4.0',
    facts,
  });
  parsed = read();
  assert.deepEqual(
    parsed.definitions.map((definition) => definition.release),
    ['1.3.0', '1.4.0'],
  );
  assert.equal(parsed.definitions[0].columns.total, undefined);
  assert.deepEqual(parsed.definitions[1].columns.total, { type: 'INTEGER' });

  // The check regenerates each definition from that release's manifests: a
  // hand edit fails, naming the command that writes it.
  const factsFor = (release) => (release === '1.3.0' ? older : facts);
  const gate = path.join(repo, 'packages/core/release-upgrade');
  assert.deepEqual(
    checkRetiredFacts({ root: repo, directory: gate, factsFor }),
    [],
  );
  const json = JSON.parse(readFileSync(path.join(pkgDir, 'package.json')));
  json.smrt.retiredTables[0].definitions[1].columns.total = { type: 'TEXT' };
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(json));
  assert.match(
    checkRetiredFacts({ root: repo, directory: gate, factsFor }).join('\n'),
    /definition of release 1\.4\.0 is not what that release's published manifests give.*--release 1\.4\.0/,
  );

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

  // The check regenerates the owners file: a hand edit fails.
  const owners = { facts_order_drafts: [`${PKG}:OrderDraft`] };
  const emptyRepo = path.join(scratch, 'empty-repo');
  mkdirSync(path.join(emptyRepo, 'packages'), { recursive: true });
  const factsFor = () => ({ owners, columns: {} });
  assert.deepEqual(
    checkRetiredFacts({ root: emptyRepo, directory, factsFor }),
    [],
  );
  const edited = JSON.parse(readFileSync(file));
  edited.owners.facts_order_drafts.push(`${PKG}:Forged`);
  writeFileSync(file, JSON.stringify(edited));
  assert.match(
    checkRetiredFacts({ root: emptyRepo, directory, factsFor }).join('\n'),
    /owners\/1\.4\.0\.json is not what release 1\.4\.0's published manifests give/,
  );
});

test('only model classes own a table: a collection class is never an owner', () => {
  const facts = releaseFacts(core, [
    {
      packageName: PKG,
      manifest: manifest(PKG, [
        {
          name: 'orderdraft',
          className: 'OrderDraft',
          collection: 'facts_order_drafts',
          decoratorConfig: { tableName: 'facts_order_drafts' },
          fields: { title: { type: 'text' } },
        },
        {
          name: 'orderdraftcollection',
          className: 'OrderDraftCollection',
          collection: 'facts_order_drafts',
          extends: 'SmrtCollection',
          collectionOf: `${PKG}:OrderDraft`,
          fields: {},
        },
      ]),
    },
  ]);
  assert.deepEqual(facts.owners.facts_order_drafts, [`${PKG}:OrderDraft`]);
});

test('refresh brings overlays and definitions in line with the snapshot set, idempotently', () => {
  const repo = path.join(scratch, 'refresh-repo');
  const pkgDir = path.join(repo, 'packages/orders');
  const gate = path.join(repo, 'packages/core/release-upgrade');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(path.join(gate, 'snapshots'), { recursive: true });
  mkdirSync(path.join(gate, 'owners'), { recursive: true });
  const snapshot = (release, modelTables) =>
    writeFileSync(
      path.join(gate, `snapshots/${release}.json`),
      JSON.stringify({ release, tables: {}, modelTables }),
    );
  // 1.3.0 predates the table; 1.4.0 and 1.5.0 hold it; 1.2.0 is gone.
  snapshot('1.3.0', []);
  snapshot('1.4.0', ['facts_order_drafts']);
  snapshot('1.5.0', ['facts_order_drafts']);
  writeFileSync(
    path.join(gate, 'owners/1.2.0.json'),
    JSON.stringify({ release: '1.2.0', source: 'published package manifests', owners: {} }),
  );
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: PKG,
      version: '1.5.0',
      smrt: {
        retiredTables: [
          {
            table: 'facts_order_drafts',
            lastOwner: `${PKG}:OrderDraft`,
            since: '1.5.0',
            reason: 'Drafts live on the order.',
            rows: 'discard',
            definitions: [{ release: '1.2.0', columns: {} }],
          },
        ],
      },
    }),
  );
  const facts = releaseFacts(core, [{ packageName: PKG, manifest: ordersManifest() }]);
  const factsFor = () => facts;
  const once = () => refreshRetiredFacts({ root: repo, directory: gate, factsFor });
  const summary = once();
  assert.deepEqual(summary.owners, ['1.3.0', '1.4.0', '1.5.0']);
  assert.deepEqual(summary.removed, ['1.2.0']);
  const read = () => ({
    owners: readdirSync(path.join(gate, 'owners')).sort(),
    package: readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
    overlay: readFileSync(path.join(gate, 'owners/1.4.0.json'), 'utf8'),
  });
  const first = read();
  assert.deepEqual(first.owners, ['1.3.0.json', '1.4.0.json', '1.5.0.json']);
  assert.deepEqual(
    JSON.parse(first.package).smrt.retiredTables[0].definitions.map(
      (definition) => definition.release,
    ),
    ['1.4.0', '1.5.0'],
  );
  // The 1.3.0 snapshot holds no such table: its overlay is empty.
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(gate, 'owners/1.3.0.json'))).owners,
    {},
  );
  once();
  assert.deepEqual(read(), first);
  assert.deepEqual(checkRetiredFacts({ root: repo, directory: gate, factsFor }), []);
});

test("reads a built checkout's own manifests: only packages published at the release", () => {
  const dir = path.join(scratch, 'checkout');
  const put = (folder, json, content) => {
    mkdirSync(path.join(dir, 'packages', folder, 'dist'), { recursive: true });
    writeFileSync(
      path.join(dir, 'packages', folder, 'package.json'),
      JSON.stringify(json),
    );
    if (content)
      writeFileSync(
        path.join(dir, 'packages', folder, 'dist/manifest.json'),
        JSON.stringify(content),
      );
  };
  put('orders', { name: PKG, version: '1.4.0' }, ordersManifest());
  put('stale', { name: '@facts5005/stale', version: '1.3.0' }, ordersManifest());
  put('hidden', { name: '@facts5005/hidden', version: '1.4.0', private: true }, ordersManifest());
  put('plain', { name: '@facts5005/plain', version: '1.4.0' });
  const manifests = loadCheckoutManifests({ root: dir, release: '1.4.0' });
  assert.deepEqual(
    manifests.map((entry) => entry.packageName),
    [PKG],
  );
  assert.deepEqual(releaseFacts(core, manifests).owners, {
    facts_order_drafts: [`${PKG}:OrderDraft`],
  });
  assert.throws(
    () => loadCheckoutManifests({ root: dir, release: '9.9.9' }),
    /No built manifests at release 9\.9\.9.*pnpm build/,
  );
  put('liar', { name: '@facts5005/liar', version: '1.4.0' }, ordersManifest());
  assert.throws(
    () => loadCheckoutManifests({ root: dir, release: '1.4.0' }),
    /names @facts5005\/orders, not @facts5005\/liar/,
  );
});

test('the online owners check is skipped with a message when npm cannot answer, and compares when it can', async () => {
  const directory = path.join(scratch, 'verify');
  mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
  writeFileSync(
    path.join(directory, 'snapshots/1.4.0.json'),
    JSON.stringify({ release: '1.4.0', tables: {}, modelTables: ['facts_order_drafts'] }),
  );
  const owners = { facts_order_drafts: [`${PKG}:OrderDraft`] };
  writeOwnersOverlay({ directory, release: '1.4.0', owners });
  const emptyRepo = path.join(scratch, 'verify-repo');
  mkdirSync(path.join(emptyRepo, 'packages'), { recursive: true });
  let read = 0;
  const factsFor = () => {
    read++;
    return { owners, columns: {} };
  };
  const run = (probe, facts = factsFor) =>
    verifyRetiredFactsOnline({
      root: emptyRepo,
      directory,
      releases: ['1.4.0'],
      probe,
      factsFor: facts,
    });

  const offline = await run(() => ({ state: 'offline', message: 'getaddrinfo ENOTFOUND registry.npmjs.org' }));
  assert.equal(offline.state, 'skipped');
  assert.equal(
    offline.message,
    'Owners check skipped: npm is not reachable (getaddrinfo ENOTFOUND registry.npmjs.org). Run node scripts/retired-table-facts.mjs check --release 1.4.0 when it is.',
  );
  const unpublished = await run(() => ({ state: 'unpublished', message: 'E404' }));
  assert.equal(unpublished.state, 'skipped');
  assert.match(unpublished.message, /smrt 1\.4\.0 is not on npm yet/);
  assert.equal(read, 0);

  const verified = await run(() => ({ state: 'online' }));
  assert.deepEqual(verified, {
    state: 'verified',
    failures: [],
    message: 'Owners check: 1.4.0 match the published manifests',
  });
  const differs = await run(
    () => ({ state: 'online' }),
    () => ({ owners: { facts_order_drafts: [`${PKG}:Other`] }, columns: {} }),
  );
  assert.equal(differs.state, 'failed');
  assert.match(differs.failures.join(), /owners\/1\.4\.0\.json is not what release 1\.4\.0/);
});
