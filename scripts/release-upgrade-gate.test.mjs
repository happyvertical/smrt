import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  capture,
  introspect,
  loadBuild,
  moveOldest,
  prune,
  rehearse,
  restore,
  seed,
  selectPrevious,
  stableJSON,
  validateLeftovers,
  validateOldest,
} from './lib/release-upgrade-gate.mjs';
import { ManifestGenerator } from '../packages/core/dist/scanner/manifest-generator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = await loadBuild(root, { manifests: false });
const release = '0.60.17';
const tableName = 'gate4933s';
const col = (type, notNull = false, defaultExpr = null) => ({
  type,
  notNull,
  default: defaultExpr,
  identity: '',
  generated: '',
});
function oldSnapshot(value = col('text'), extra = {}) {
  return {
    format: 1,
    release,
    engine: 'postgres',
    capturedFrom: 'migrateSmrtSchemas on an empty database',
    tables: {
      [tableName]: {
        columns: {
          id: col('uuid', true),
          slug: col('text', true),
          context: col('text', true, "''::text"),
          created_at: col(
            'timestamp with time zone',
            true,
            'CURRENT_TIMESTAMP',
          ),
          updated_at: col(
            'timestamp with time zone',
            true,
            'CURRENT_TIMESTAMP',
          ),
          _sync_origin_device_id: col('text'),
          _sync_revision: col('bigint'),
          value,
          ...extra,
        },
        primaryKey: ['id'],
        constraints: [
          {
            name: 'gate4933s_pkey',
            type: 'p',
            definition: 'PRIMARY KEY (id)',
            columns: ['id'],
            referencesTable: null,
            referencesColumns: [],
          },
        ],
        indexes: [],
      },
    },
  };
}
function current(fields = { value: { type: 'text', required: false } }) {
  build.ObjectRegistry.clear();
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: '/gate4933',
        errors: [],
        objects: [
          {
            name: 'gate4933',
            className: 'Gate4933',
            collection: tableName,
            filePath: '/gate4933/model.ts',
            fields,
            methods: {},
            decoratorConfig: {},
            packageName: '@test/gate4933',
            extends: 'SmrtObject',
          },
        ],
      },
    ],
    { packageName: '@test/gate4933' },
  );
  for (const [key, definition] of Object.entries(manifest.objects))
    build.ObjectRegistry.registerFromManifest(
      key,
      definition,
      '@test/gate4933',
    );
  return build;
}
const run = (snapshot, options = {}) =>
  rehearse({ root, snapshot, build, ...options });
const textOf = (result) => result.failures.join('\n');

test('required to optional with rows (#4920) passes and physically drops NOT NULL', async () => {
  current();
  const result = await run(oldSnapshot(col('text', true)), {
    inspect: async (db) => {
      const live = await introspect(db, release);
      assert.equal(live.tables[tableName].columns.value.notNull, false);
      assert.equal(
        (await db.query(`SELECT value FROM ${tableName}`)).rows.length,
        1,
      );
    },
  });
  assert.equal(result.ok, true, textOf(result));
  assert.equal(result.seededTables, 1);
  assert.deepEqual(result.seedWarnings, []);
});
test('optional to required with NULL and no data step fails naming table.column', async () => {
  current({ value: { type: 'text', required: true } });
  const result = await run(oldSnapshot());
  assert.equal(result.ok, false);
  assert.match(textOf(result), /gate4933s\.value/);
  assert.match(textOf(result), /invent|NULL/i);
});
test('optional to required with a shipped default passes and fills the row', async () => {
  current({ value: { type: 'text', required: true, default: 'repaired' } });
  const result = await run(oldSnapshot(), {
    inspect: async (db) => {
      assert.deepEqual(
        (await db.query(`SELECT value FROM ${tableName}`)).rows,
        [{ value: 'repaired' }],
      );
    },
  });
  assert.equal(result.ok, true, textOf(result));
});
test('optional to required with a shipped per-row backfill passes', async () => {
  current({ value: { type: 'text', required: true, backfill: 'slug' } });
  const result = await run(oldSnapshot(), {
    inspect: async (db) => {
      assert.equal(
        (await db.query(`SELECT value=slug AS filled FROM ${tableName}`))
          .rows[0].filled,
        true,
      );
    },
  });
  assert.equal(result.ok, true, textOf(result));
});
test('new required column with no default on a populated table fails by name', async () => {
  current({ value: { type: 'text' }, added: { type: 'text', required: true } });
  const result = await run(oldSnapshot());
  assert.equal(result.ok, false);
  assert.match(textOf(result), /gate4933s\.added/);
});
test('new required column with a shipped backfill passes', async () => {
  current({
    value: { type: 'text' },
    added: { type: 'text', required: true, backfill: 'slug' },
  });
  const result = await run(oldSnapshot());
  assert.equal(result.ok, true, textOf(result));
});
test('removed column holding old data fails naming table.column and old release', async () => {
  current({});
  const result = await run(oldSnapshot(col('text', true)));
  assert.equal(result.ok, false);
  assert.match(textOf(result), /gate4933s\.value.*0\.60\.17/);
});
test('recorded leftover with a reason permits the same retained column', async () => {
  current({});
  const result = await run(
    oldSnapshot(col('text', false, "'retained'::text")),
    {
      leftovers: [
        {
          table: tableName,
          column: 'value',
          since: release,
          reason: 'Historical import provenance retained for audit.',
        },
      ],
    },
  );
  assert.equal(result.ok, true, textOf(result));
  assert.deepEqual(result.matchedLeftovers, [`${tableName}.value`]);
});
test('stale leftover entry fails, and missing reasons are refused', async () => {
  current();
  const result = await run(oldSnapshot(), {
    leftovers: [
      {
        table: tableName,
        column: 'gone',
        since: release,
        reason: 'Previously retained audit data.',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(textOf(result), /Stale leftover.*gate4933s.gone/);
  assert.throws(
    () =>
      validateLeftovers([
        { table: tableName, column: 'value', since: release, reason: ' ' },
      ]),
    /non-empty reason/,
  );
});
test('NOT NULL orphan without default fails even if its table could not be seeded', async () => {
  current();
  const snapshot = oldSnapshot(col('text'), { orphan: col('text', true) });
  snapshot.tables[tableName].constraints.push({
    name: 'unseedable',
    type: 'c',
    definition: 'CHECK (false)',
    columns: [],
  });
  const result = await run(snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.seededTables, 0);
  assert.match(result.seedWarnings.join(' '), /gate4933s/);
  assert.match(textOf(result), /gate4933s.orphan.*blocks new inserts/);
});
test('a migrator that leaves actionable changes fails convergence', async () => {
  current();
  const result = await run(oldSnapshot(), {
    build: { ...build, migrateSmrtSchemas: async () => ({ refused: false }) },
  });
  assert.equal(result.ok, false);
  assert.match(textOf(result), /did not converge/);
});
test('a thrown migrate error reports the release and planned statements', async () => {
  current();
  const result = await run(oldSnapshot(), {
    build: {
      ...build,
      migrateSmrtSchemas: async () => {
        throw new Error('table.column migration failed');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(textOf(result), /0.60.17.*table.column/);
  assert.match(textOf(result), /Planned statement/);
});
test('capture is stable and restore round trips catalogs and bookkeeping', async () => {
  current();
  const first = await capture({ root, build });
  const second = await capture({ root, build });
  assert.equal(stableJSON(first), stableJSON(second));
  const db = await restore(first, { root });
  try {
    assert.equal(
      stableJSON(
        await introspect(db, first.release, {
          modelTables: first.modelTables,
        }),
      ),
      stableJSON(first),
    );
  } finally {
    await db.close();
  }
});
test('seed supports FK cycles, enum CHECKs, uuid/json/timestamps, arrays and bytea', async () => {
  const tables = {};
  for (const name of ['cycle_a', 'cycle_b']) {
    const other = name === 'cycle_a' ? 'cycle_b' : 'cycle_a';
    tables[name] = {
      columns: {
        id: col('uuid', true),
        parent_id: col('uuid', true),
        status: col('text', true),
        payload: col('jsonb', true),
        stamp: col('timestamp with time zone', true),
        day: col('date', true),
        tags: col('text[]', true),
        bytes: col('bytea', true),
        count: col('bigint', true),
        amount: col('numeric', true),
        flag: col('boolean', true),
      },
      primaryKey: ['id'],
      indexes: [],
      constraints: [
        {
          name: `${name}_pkey`,
          type: 'p',
          definition: 'PRIMARY KEY (id)',
          columns: ['id'],
        },
        {
          name: `${name}_parent`,
          type: 'f',
          definition: `FOREIGN KEY (parent_id) REFERENCES ${other}(id)`,
          columns: ['parent_id'],
          referencesTable: other,
          referencesColumns: ['id'],
        },
        {
          name: `${name}_status`,
          type: 'c',
          definition:
            "CHECK ((status = ANY (ARRAY['ready'::text, 'done'::text])))",
          columns: ['status'],
        },
      ],
    };
  }
  const snapshot = { format: 1, release, engine: 'postgres', tables };
  const db = await restore(snapshot, { root });
  try {
    const seeded = await seed(db, snapshot);
    assert.deepEqual(seeded, { seededTables: 2, seedWarnings: [] });
    const rows = (
      await db.query(
        'SELECT a.status, a.payload, a.parent_id=b.id AS linked FROM cycle_a a CROSS JOIN cycle_b b',
      )
    ).rows;
    assert.deepEqual(rows, [{ status: 'ready', payload: {}, linked: true }]);
    assert.equal(
      (
        await db.query(
          'SELECT a.parent_id=b.id AS linked FROM cycle_b a CROSS JOIN cycle_a b',
        )
      ).rows[0].linked,
      true,
    );
    assert.equal(
      (await db.query('SHOW session_replication_role')).rows[0]
        .session_replication_role,
      'origin',
    );
  } finally {
    await db.close();
  }
});

test('previous selection uses numeric versions and includes current version', () => {
  const versions = ['0.60.9', '0.60.17', '0.60.10', '0.61.0-rc.1', '0.61.0'];
  assert.equal(
    selectPrevious(versions, '0.60.17', build.compareReleases),
    '0.60.17',
  );
  assert.equal(
    selectPrevious(versions, '0.60.18', build.compareReleases),
    '0.60.17',
  );
  assert.equal(
    selectPrevious(versions, '0.61.0-rc.2', build.compareReleases),
    '0.61.0-rc.1',
  );
  assert.throws(
    () => selectPrevious([], release, build.compareReleases),
    /No release snapshot/,
  );
});
const scratch = mkdtempSync(path.join(tmpdir(), 'release-upgrade-4933-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
function records(
  name,
  versions = ['0.60.17', '0.60.18', '0.60.19', '0.60.20'],
) {
  const directory = path.join(scratch, name);
  mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
  for (const version of versions)
    writeFileSync(
      path.join(directory, `snapshots/${version}.json`),
      stableJSON({ ...oldSnapshot(), release: version }),
    );
  writeFileSync(
    path.join(directory, 'oldest-supported.json'),
    stableJSON({
      release,
      snapshot: `snapshots/${release}.json`,
      decision: 'First release whose schema was saved.',
      recordedAt: '2026-11-12',
      history: [],
    }),
  );
  return directory;
}
test('move-oldest requires first hop, reason and existing snapshots; records history', () => {
  const directory = records('move');
  const options = {
    directory,
    to: '0.60.19',
    upgradeFirstTo: '0.60.18',
    reason: 'Remove the old data step.',
    compare: build.compareReleases,
  };
  assert.throws(() => moveOldest({ ...options, reason: '' }), /--reason/);
  assert.throws(
    () => moveOldest({ ...options, upgradeFirstTo: undefined }),
    /--upgrade-first-to/,
  );
  assert.throws(() => moveOldest({ ...options, to: '0.60.99' }), /ENOENT/);
  assert.throws(
    () => moveOldest({ ...options, upgradeFirstTo: '0.60.99' }),
    /ENOENT/,
  );
  assert.throws(() => moveOldest({ ...options, to: release }), /move forward/);
  const next = moveOldest(options);
  assert.equal(next.history[0].release, release);
  assert.match(next.decision, /smrt 0.60.18/);
  assert.equal(
    validateOldest(directory, build.compareReleases).release,
    '0.60.19',
  );
  next.decision = 'No first hop';
  writeFileSync(
    path.join(directory, 'oldest-supported.json'),
    stableJSON(next),
  );
  assert.throws(
    () => validateOldest(directory, build.compareReleases),
    /must name the release/,
  );
});
test('oldest record validator refuses mismatched file name, release and empty decision', () => {
  const directory = records('invalid');
  const file = path.join(directory, 'oldest-supported.json');
  const record = JSON.parse(readFileSync(file));
  for (const change of [
    { snapshot: 'snapshots/0.60.18.json' },
    { decision: '' },
  ]) {
    writeFileSync(file, stableJSON({ ...record, ...change }));
    assert.throws(() => validateOldest(directory, build.compareReleases));
  }
  writeFileSync(file, stableJSON(record));
  writeFileSync(
    path.join(directory, record.snapshot),
    stableJSON({ ...oldSnapshot(), release: '0.60.18' }),
  );
  assert.throws(
    () => validateOldest(directory, build.compareReleases),
    /does not match/,
  );
});
test('prune keeps oldest supported snapshot and the newest two others', () => {
  const directory = records('prune');
  assert.deepEqual(prune(directory, release, build.compareReleases), [
    release,
    '0.60.19',
    '0.60.20',
  ]);
  assert.equal(
    existsSync(path.join(directory, 'snapshots/0.60.18.json')),
    false,
  );
});

test('prune preserves the first-hop snapshot required by a recorded floor move', () => {
  const directory = records('prune-hop', [
    '0.60.17',
    '0.60.18',
    '0.60.19',
    '0.60.20',
    '0.60.21',
  ]);
  moveOldest({
    directory,
    to: '0.60.20',
    upgradeFirstTo: '0.60.17',
    reason: 'Remove the older conversion.',
    compare: build.compareReleases,
  });
  assert.deepEqual(prune(directory, '0.60.20', build.compareReleases), [
    '0.60.17',
    '0.60.19',
    '0.60.20',
    '0.60.21',
  ]);
  assert.equal(
    validateOldest(directory, build.compareReleases).upgradeFirstTo,
    '0.60.17',
  );
});

test('required FK uses the actual default in a seeded non-PK unique parent column', async () => {
  const snapshot = {
    format: 1,
    release,
    engine: 'postgres',
    tables: {
      parents: {
        columns: {
          id: col('integer', true),
          code: col('text', true, "'default-code'::text"),
        },
        primaryKey: ['id'],
        indexes: [],
        constraints: [
          {
            name: 'parents_pkey',
            type: 'p',
            definition: 'PRIMARY KEY (id)',
            columns: ['id'],
          },
          {
            name: 'parents_code_key',
            type: 'u',
            definition: 'UNIQUE (code)',
            columns: ['code'],
          },
        ],
      },
      children: {
        columns: { id: col('integer', true), parent_code: col('text', true) },
        primaryKey: ['id'],
        indexes: [],
        constraints: [
          {
            name: 'children_pkey',
            type: 'p',
            definition: 'PRIMARY KEY (id)',
            columns: ['id'],
          },
          {
            name: 'children_parent_fk',
            type: 'f',
            definition: 'FOREIGN KEY (parent_code) REFERENCES parents(code)',
            columns: ['parent_code'],
            referencesTable: 'parents',
            referencesColumns: ['code'],
          },
        ],
      },
    },
  };
  const db = await restore(snapshot, { root });
  try {
    assert.deepEqual(await seed(db, snapshot), {
      seededTables: 2,
      seedWarnings: [],
    });
    assert.deepEqual(
      (await db.query('SELECT parent_code FROM children')).rows,
      [{ parent_code: 'default-code' }],
    );
  } finally {
    await db.close();
  }
});

test('a leftover reason cannot waive an orphan that blocks new inserts', async () => {
  current({});
  const result = await run(oldSnapshot(col('text', true)), {
    leftovers: [
      {
        table: tableName,
        column: 'value',
        since: release,
        reason: 'Retained import provenance.',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(textOf(result), /gate4933s.value.*blocks new inserts/);
});

test('_smrt_ model tables are seeded and checked for orphan data; prefix is not bookkeeping', async () => {
  current();
  const snapshot = oldSnapshot(col('text', true));
  const original = snapshot.tables[tableName];
  delete snapshot.tables[tableName];
  snapshot.tables._smrt_gate4933 = original;
  original.constraints[0].name = '_smrt_gate4933_pkey';
  const result = await run(snapshot);
  assert.equal(result.seededTables, 1);
  assert.deepEqual(result.seedWarnings, []);
  assert.equal(result.ok, false);
  assert.match(textOf(result), /_smrt_gate4933.value.*0.60.17/);
});

test('snapshot model ownership excludes private bookkeeping from seed and orphan checks', async () => {
  current();
  const snapshot = oldSnapshot();
  snapshot.modelTables = [tableName];
  snapshot.tables._smrt_private_queue = {
    columns: { id: col('text', true), release: col('text', true) },
    primaryKey: ['id'],
    indexes: [],
    constraints: [
      {
        name: '_smrt_private_queue_pkey',
        type: 'p',
        definition: 'PRIMARY KEY (id)',
        columns: ['id'],
      },
    ],
    rows: [],
  };
  const result = await run(snapshot);
  assert.equal(result.seededTables, 1);
  assert.deepEqual(result.seedWarnings, []);
  assert.equal(result.ok, true, textOf(result));
});
