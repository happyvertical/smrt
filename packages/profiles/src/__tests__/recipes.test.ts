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
