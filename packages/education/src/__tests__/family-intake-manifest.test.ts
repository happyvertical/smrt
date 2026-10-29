import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('publishes closed tenant-owned family schemas independently from learner attribution', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../.smrt/manifest.json', import.meta.url), 'utf8'),
  );
  const expected = {
    FamilyIntake: [
      'item_id',
      'actor_user_id',
      'owner_profile_id',
      'content_digest',
      'source_json',
    ],
    FamilyIntakeAsset: [
      'intake_id',
      'asset_id',
      'name',
      'mime_type',
      'sha256',
      'position',
    ],
    FamilyIntakeDecision: [
      'intake_id',
      'actor_user_id',
      'request_key',
      'sequence',
      'body_json',
    ],
  };
  for (const [name, columns] of Object.entries(expected)) {
    const object = manifest.objects[`@happyvertical/smrt-education:${name}`];
    expect(object.decoratorConfig).toMatchObject({
      api: false,
      cli: false,
      mcp: false,
    });
    expect(object.schema.columns.tenant_id).toMatchObject({
      type: 'UUID',
      notNull: true,
    });
    expect(object.schema.columns).not.toHaveProperty('learner_id');
    for (const column of columns)
      expect(object.schema.columns).toHaveProperty(column);
  }
  expect(
    manifest.objects['@happyvertical/smrt-education:WorkbookPhotoIntake'].schema
      .columns.family_intake_id,
  ).toMatchObject({
    type: 'UUID',
    notNull: false,
    foreignKey: { table: 'family_intakes', column: 'id' },
  });
});
