import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EducationSupervisorRecipe } from '../recipes.js';

it('ships the supervisor recipe with closed native-UUID sharing models', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../.smrt/manifest.json', import.meta.url), 'utf8'),
  );
  const names = [
    'EducationGroup',
    'GroupLearnerInvitation',
    'GroupLearnerMembership',
    'GroupLearnerRosterEntry',
    'GroupSharingPolicy',
    'GroupRevisionComment',
  ];
  expect(EducationSupervisorRecipe.id).toBe('education.supervisor');
  expect(EducationSupervisorRecipe.models.map((model) => model.name)).toEqual(
    expect.arrayContaining(names),
  );
  for (const name of names) {
    const object = manifest.objects[`@happyvertical/smrt-education:${name}`];
    expect(object.decoratorConfig).toMatchObject({
      api: false,
      mcp: false,
      cli: false,
      ai: { callable: [] },
    });
    for (const column of ['id', 'tenant_id']) {
      expect(object.schema.columns[column]).toMatchObject({
        type: 'UUID',
        notNull: true,
      });
    }
  }
  const comment =
    manifest.objects['@happyvertical/smrt-education:GroupRevisionComment'];
  expect(comment.schema.columns.revision_id.foreignKey.table).toBe(
    'workbook_assessment_revisions',
  );
  expect(comment.schema.columns.membership_id.foreignKey.table).toBe(
    'group_learner_memberships',
  );
});
