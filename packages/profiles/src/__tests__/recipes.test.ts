import { expect, it } from 'vitest';
import { AuditLog } from '../models/AuditLog.js';
import { AuditLogRecipe } from '../recipes.js';

it('offers authorized activity independently without advertising a generated audit route', () => {
  expect(AuditLogRecipe.id).toBe('profiles.audit-log');
  expect(AuditLogRecipe.group?.id).toBe('activity');
  expect(AuditLogRecipe.section?.id).toBe('activity');
  expect(AuditLogRecipe.requires).toEqual([]);
  expect(AuditLogRecipe.requiresAny).toEqual([]);
  expect(AuditLogRecipe.models).toEqual([AuditLog]);
  expect(AuditLogRecipe.nav).toEqual([]);
});

it('requires authorized audit data for the activity route and offers only presentation seed data', () => {
  expect(AuditLogRecipe.surfaces).toEqual([
    {
      kind: 'route',
      path: '/activity',
      export: '@happyvertical/smrt-svelte#ActivityList',
      label: 'Activity log',
    },
  ]);
  expect(AuditLogRecipe.providers).toEqual([
    {
      id: 'audit-trail',
      kind: 'activity',
      options: ['audit-log'],
      required: true,
    },
  ]);
  expect(AuditLogRecipe.runtime).toBe('both');
  expect(AuditLogRecipe.demoSeed.data.entries[0].href).toBeNull();
  expect(AuditLogRecipe.demoSeed.data.entries[0]).not.toHaveProperty('changes');
});
