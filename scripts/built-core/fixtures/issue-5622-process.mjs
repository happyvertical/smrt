import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SmrtCollection,
  SmrtObject,
  ObjectRegistry,
} from '../../../packages/core/dist/index.js';
import {
  computeSchemaFingerprint,
  describeManifestSchema,
  migrateSmrtSchemas,
  readLastMigrateRecord,
} from '../../../packages/core/dist/migrations.js';
const sqlPackage = findPackageJSON(
  '@happyvertical/sql',
  new URL('../../../packages/core/package.json', import.meta.url),
);
const sqlEntry = JSON.parse(readFileSync(sqlPackage, 'utf8')).exports['.']
  .import;
const { getDatabase } = await import(
  pathToFileURL(resolve(dirname(sqlPackage), sqlEntry)).href
);
const [phase, path, url] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'production');
assert.notEqual(process.env.SMRT_ALLOW_UNMIGRATED_START, '1');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
class Entity extends SmrtObject {}
class Person extends Entity {}
class Subscription extends SmrtObject {
  personId = null;
}
const classes = { Entity, Person, Subscription };
for (const [key, entry] of Object.entries(manifest.objects)) {
  ObjectRegistry.register(classes[entry.className], {
    ...entry.decoratorConfig,
    name: entry.className,
    packageName: entry.packageName,
    _manifest: {
      ...manifest,
      packageName: entry.packageName,
      objects: { [key]: entry },
    },
    _manifestKey: key,
  });
}
class Subscriptions extends SmrtCollection {
  static _itemClass = Subscription;
}
const db = await getDatabase({ type: 'sqlite', url });
try {
  if (phase === 'migrate') {
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    const physical = schemas.fk5622_subscriptions.columns.person_id.foreignKey;
    assert.equal(physical?.table, 'fk5622_entities');
    const build = describeManifestSchema(manifest);
    assert.equal(computeSchemaFingerprint(schemas), build.fingerprint);
    const migrated = await migrateSmrtSchemas({
      db,
      packageName: '@fk5622/app',
    });
    assert.equal(migrated.refused, false);
    const last = await readLastMigrateRecord(db);
    assert.equal(last.state, 'recorded');
    const record = last.record;
    assert.equal(record.fingerprint, build.fingerprint);
    const constraints = await db.query(
      'PRAGMA foreign_key_list("fk5622_subscriptions")',
    );
    assert.ok(
      constraints.rows.some(
        (row) => row.table === 'fk5622_entities' && row.from === 'person_id',
      ),
    );
    console.log(
      JSON.stringify({
        migrated: migrated.applied,
        fingerprint: record.fingerprint,
      }),
    );
  } else if (phase === 'query') {
    const collection = await Subscriptions.create({ db });
    console.log(JSON.stringify({ count: await collection.count() }));
  } else {
    const collection = await Subscriptions.create({ db });
    await assert.rejects(
      () => collection.count(),
      (error) => error.code === 'DB_MIGRATION_REQUIRED',
    );
    console.log(JSON.stringify({ refused: true }));
  }
} finally {
  await db.close();
}
