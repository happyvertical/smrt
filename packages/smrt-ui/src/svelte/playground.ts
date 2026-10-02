const loadBaseControls = () =>
  import('./playground/BaseControlsPreview.svelte');
const loadDataTable = () => import('./playground/DataTablePreview.svelte');
const loadInteractiveControls = () =>
  import('./playground/InteractiveControlsPreview.svelte');
const loadFeedback = () => import('./playground/FeedbackPreview.svelte');
const loadCollections = () => import('./playground/CollectionsPreview.svelte');
const loadCalendar = () => import('./playground/CalendarPreview.svelte');
const loadCapture = () => import('./playground/CapturePreview.svelte');

export default {
  packageName: '@happyvertical/smrt-ui',
  displayName: 'UI Foundation',
  description:
    'Provider-free controls and data primitives rendered in the active s-m-r-t theme.',
  entries: [
    {
      id: 'base-controls',
      title: 'Base Controls',
      description:
        'Inputs, select, textarea, toggle, form grouping, buttons, and status badges.',
      loadComponent: loadBaseControls,
      order: 1,
      tags: ['forms', 'inputs', 'buttons', 'badges'],
      modes: {
        mock: {
          label: 'Interactive',
        },
      },
    },
    {
      id: 'interactive-controls',
      title: 'Interactive Controls',
      description:
        'Checkboxes, switches, radios, sliders, ranges, segmented choices, comboboxes, multiselect, tags, date/time, files, and agent interaction.',
      loadComponent: loadInteractiveControls,
      order: 2,
      tags: ['forms', 'sliders', 'choices', 'agent-interaction'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'feedback-overlays',
      title: 'Feedback & Overlays',
      description:
        'Alerts, toasts, progress, meters, spinners, popovers, menus, disclosure, accordions, and drawers.',
      loadComponent: loadFeedback,
      order: 3,
      tags: ['feedback', 'progress', 'overlays'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'collections',
      title: 'Collections & Content Lists',
      description:
        'Reusable collection toolbar and selectable list/grid pattern for content-heavy applications.',
      loadComponent: loadCollections,
      order: 4,
      tags: ['content', 'list', 'grid', 'search'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'data-table',
      title: 'Data Table',
      description:
        'Accessible local and manual tables with query lifecycle states, grouped reports, saved layout, responsive overflow, and virtualization.',
      loadComponent: loadDataTable,
      order: 5,
      tags: ['data', 'table', 'manual-query', 'reporting', 'accessibility'],
      modes: {
        mock: {
          label: 'Interactive',
        },
      },
    },
    {
      id: 'calendar',
      title: 'Calendar',
      description:
        'Time-zone-aware month grid with all-day bands and "+N more", and the phone agenda (day strip + day list).',
      loadComponent: loadCalendar,
      order: 6,
      tags: ['calendar', 'events', 'agenda', 'mobile'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'capture',
      title: 'Camera & Signature Capture',
      description:
        'Live camera capture with review and retake, and a stylus-aware signature pad, both posting files through a native multipart form.',
      loadComponent: loadCapture,
      order: 7,
      tags: ['forms', 'camera', 'signature', 'files'],
      modes: { mock: { label: 'Interactive' } },
    },
  ],
};
