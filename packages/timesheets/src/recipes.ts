/**
 * Declared recipes for smrt-timesheets (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { ServiceTimeEntry } from './models/service-time-entry.js';

/** Time entries: Record who worked how long on what, and approve it. */
export class TimeEntriesRecipe extends SmrtRecipe {
  static id = 'timesheets.time-entries';
  static help = './time-entries.recipe.md';
  static label = 'Time entries';
  static summary = 'Record who worked how long on what, and approve it.';
  static synonyms = [
    'timesheets',
    'time tracking',
    'hours',
    'billable hours',
    'timecards',
  ];
  static section = {
    id: 'work',
    label: 'Work',
    icon: 'wrench',
    description: 'Time and costs: the work behind each job.',
  };
  static models = [ServiceTimeEntry];
  static nav = [
    {
      label: 'Time entries',
      model: ServiceTimeEntry,
      icon: 'fileText',
      description:
        'Hours worked, by person and by job, from draft to approved.',
    },
  ];
  static options = {
    ServiceTimeEntry: {
      fields: {
        participantProfileId: { label: 'Person', order: 1 },
        description: {
          order: 2,
          help: 'What the time was spent on, in a few words.',
        },
        startedAt: { label: 'Started', order: 3 },
        endedAt: { label: 'Ended', order: 4 },
        durationSeconds: {
          label: 'Duration (seconds)',
          order: 5,
          help: 'Whole seconds: 3600 is one hour.',
        },
        status: { order: 6 },
        workRefId: {
          label: 'Work reference',
          order: 7,
          help: 'The job, project or case this time belongs to.',
        },
        rejectionReason: { order: 8 },
        workRefType: { visibility: 'hidden' },
        participantKind: { default: 'human', visibility: 'hidden' },
        agentRef: { visibility: 'hidden' },
        source: { default: 'manual', visibility: 'hidden' },
        evidence: { visibility: 'hidden' },
        approvalPath: { visibility: 'hidden' },
        submittedAt: { visibility: 'hidden' },
        submittedByProfileId: { visibility: 'hidden' },
        approvedByProfileId: { visibility: 'hidden' },
        rejectedAt: { visibility: 'hidden' },
        rejectedByProfileId: { visibility: 'hidden' },
        correctionOfId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
  } as const;
}
