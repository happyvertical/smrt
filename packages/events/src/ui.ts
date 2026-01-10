/**
 * Events Module UI Slot Declarations
 *
 * This file defines the UI extension points for the events module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Events module UI slots
 */
export const EVENTS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'meeting-view': {
    id: 'meeting-view',
    label: 'Meeting View',
    description: 'Full meeting details with documents and resources',
    icon: 'calendar',
    category: 'detail',
    order: 1,
    propsInterface: 'MeetingViewProps',
  },
};

/**
 * Events module metadata
 */
export const EVENTS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-events',
  displayName: 'Events',
  description: 'Hierarchical event management with participant tracking',
  uiSlots: EVENTS_UI_SLOTS,
  models: ['Event', 'EventParticipant', 'EventSeries', 'Meeting', 'Deadline'],
  collections: [
    'EventCollection',
    'EventParticipantCollection',
    'EventSeriesCollection',
  ],
};
