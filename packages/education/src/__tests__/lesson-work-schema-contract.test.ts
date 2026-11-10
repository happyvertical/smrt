import { ObjectRegistry } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
// The package entry as a host loads it: runtime registration supplies the
// definitions its schema step compares with the deployed tables.
import '../index.js';

it('keeps the deployed workbook_activities foreign keys so existing installs need no rebuild', () => {
  const definition = Object.values(
    ObjectRegistry.getAllSchemasAsDefinitions(),
  ).find((d) => d.tableName === 'workbook_activities');
  // Deployed (pre-#4614) shape: NO ACTION on delete, CASCADE on update.
  // SQLite cannot alter a foreign key in place, so any drift here would make
  // the host's schema step demand a manual table rebuild.
  for (const [column, table] of [
    ['learner_id', 'learners'],
    ['enrollment_id', 'enrollments'],
    ['lesson_id', 'lessons'],
    ['photo_intake_id', 'workbook_photo_intakes'],
  ])
    expect(definition?.columns[column]?.foreignKey).toMatchObject({
      table,
      column: 'id',
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    });
});
