import { SmrtRecipe } from '@happyvertical/smrt-core';
import { AuditLog } from './models/AuditLog.js';

/** Authorized record history in the application activity feed. */
export class AuditLogRecipe extends SmrtRecipe {
  static id = 'profiles.audit-log';
  static label = 'Activity log';
  static summary = 'Review who changed a record and when.';
  static synonyms = ['audit trail', 'record history', 'activity'];
  static group = {
    id: 'activity',
    label: 'Activity',
    summary: 'Review authorized record history independently of messaging.',
  };
  static section = {
    id: 'activity',
    label: 'Activity',
    icon: 'book',
    description: 'See who changed records and why.',
  };
  static models = [AuditLog];
  // Audit readers are host-authorized; do not advertise a generic model route.
  static nav = [];
  static help = './help/audit-log.md';
}
