import { readFileSync } from 'node:fs';
import { getTestManifestPath } from '@happyvertical/smrt-vitest';
import { expect, it } from 'vitest';

it('emits every concrete photo ownership and provenance column in the manifest schema', () => {
  // Vitest's package scanner writes this before test collection. Runtime SQLite
  // table generation can mask a missing manifest column; PostgreSQL consumes
  // these structured columns directly.
  const manifest = JSON.parse(readFileSync(getTestManifestPath(), 'utf8'));
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
    BookContextRevision: ['course_id', 'decision_id', 'metadata_json'],
    LessonActivity: [
      'capture_kind',
      'photo_intake_id',
      'enrollment_id',
      'lesson_id',
    ],
    LessonWorkFiling: [
      'source_activity_id',
      'course_id',
      'enrollment_id',
      'lesson_id',
      'lesson_page_id',
      'previous_revision_id',
      'actor_user_id',
      'request_key',
      'reason',
      'digest',
    ],
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
  const activity =
    manifest.objects['@happyvertical/smrt-education:LessonActivity'].schema
      .columns;
  // The retired book link is gone; book identity lives on the course.
  expect(activity).not.toHaveProperty('workbook_id');
  expect(activity).not.toHaveProperty('page_key');
  expect(activity.photo_intake_id).toMatchObject({
    type: 'UUID',
    notNull: false,
    foreignKey: { table: 'workbook_photo_intakes', column: 'id' },
  });
  expect(
    activity.capture_kind.defaultValue ?? activity.capture_kind.default,
  ).toBe('identified');
  const filing =
    manifest.objects['@happyvertical/smrt-education:LessonWorkFiling'].schema
      .columns;
  expect(filing.source_activity_id).toMatchObject({
    type: 'UUID',
    notNull: true,
    foreignKey: { table: 'workbook_activities', column: 'id' },
  });
  expect(filing.lesson_page_id).toMatchObject({
    type: 'UUID',
    notNull: false,
    foreignKey: { table: 'lesson_pages', column: 'id' },
  });
  expect(manifest.objects).not.toHaveProperty(
    '@happyvertical/smrt-education:Workbook',
  );
  expect(manifest.objects).not.toHaveProperty(
    '@happyvertical/smrt-education:PhotoHistory',
  );
});
