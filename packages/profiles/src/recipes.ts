import { SmrtRecipe } from '@happyvertical/smrt-core';
import { AuditLog } from './models/AuditLog.js';

/** Authorized record history in the application activity feed. */
export class AuditLogRecipe extends SmrtRecipe {
  static id = 'profiles.audit-log';
  static label = 'Activity log';
  static summary = 'Review who changed a record and when.';
  static synonyms = ['audit trail', 'record history', 'activity'];
  static models = [AuditLog];
  static help = './help/audit-log.md';
}
