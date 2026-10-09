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
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'route',
      path: '/activity',
      export: '@happyvertical/smrt-svelte#ActivityList',
      label: 'Activity log',
    },
  ] as const;
  static providers = [
    {
      id: 'audit-trail',
      kind: 'activity',
      options: ['audit-log'],
      required: true,
    },
  ];
  static demoSeed = {
    data: {
      entries: [
        {
          id: 'demo-audit',
          title: 'Demo colleague · updated',
          detail: 'Approved a fictional record.',
          occurredAt: '2026-01-01T12:00:00Z',
          href: null,
        },
      ],
    },
  };
  // Audit readers are host-authorized; do not advertise a generic model route.
  static nav = [];
  static help = './help/audit-log.md';
}
