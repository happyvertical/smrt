/**
 * Events Module Svelte Components
 *
 * Optional Svelte UI components for the events module.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { EVENTS_MODULE_META } from '../ui.js';

// Export components
export { default as MeetingView } from './components/MeetingView.svelte';

// Export types
export * from './types.js';

// Auto-register with ModuleUIRegistry
import MeetingView from './components/MeetingView.svelte';

ModuleUIRegistry.registerModule(EVENTS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-events',
  'meeting-view',
  MeetingView,
);
