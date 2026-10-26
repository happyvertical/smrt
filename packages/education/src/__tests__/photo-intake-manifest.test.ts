import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('emits every concrete photo ownership and provenance column in the manifest schema', () => {
  // Vitest's package scanner writes this before test collection. Runtime SQLite
  // table generation can mask a missing manifest column; PostgreSQL consumes
  // these structured columns directly.
  const manifest = JSON.parse(
    readFileSync(new URL('../../.smrt/manifest.json', import.meta.url), 'utf8'),
  );
  const tables = {
    WorkbookPhotoIntake: ['item_id', 'actor_user_id', 'content_digest'],
    WorkbookPhotoAsset: [
      'intake_id',
      'asset_id',
      'name',
      'mime_type',
      'sha256',
      'position',
    ],
    WorkbookPhotoDecision: [
      'intake_id',
      'request_key',
      'sequence',
      'actor_user_id',
      'body_json',
    ],
    WorkbookContextRevision: ['workbook_id', 'decision_id', 'metadata_json'],
  };
  for (const [name, ownColumns] of Object.entries(tables)) {
    const object = manifest.objects[`@happyvertical/smrt-education:${name}`];
    expect(object.extends).toBe('SmrtObject');
    expect(object.decoratorConfig).toMatchObject({
      api: false,
      mcp: false,
      cli: false,
    });
    const columns = object.schema.columns;
    for (const name of ['id', 'tenant_id', 'learner_id', ...ownColumns])
      expect(columns).toHaveProperty(name);
    for (const name of ['id', 'tenant_id', 'learner_id'])
      expect(columns[name]).toMatchObject({ type: 'UUID', notNull: true });
    expect(columns.learner_id.foreignKey).toMatchObject({
      table: 'learners',
      column: 'id',
    });
  }
  expect(manifest.objects).not.toHaveProperty(
    '@happyvertical/smrt-education:PhotoHistory',
  );
});
