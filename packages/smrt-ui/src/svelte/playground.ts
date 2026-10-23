const loadBaseControls = () =>
  import('./playground/BaseControlsPreview.svelte');
const loadDataTable = () => import('./playground/DataTablePreview.svelte');
const loadInteractiveControls = () =>
  import('./playground/InteractiveControlsPreview.svelte');
const loadFeedback = () => import('./playground/FeedbackPreview.svelte');
const loadCollections = () => import('./playground/CollectionsPreview.svelte');
const loadCalendar = () => import('./playground/CalendarPreview.svelte');
const loadCapture = () => import('./playground/CapturePreview.svelte');
const loadTouchTools = () => import('./playground/TouchToolsPreview.svelte');
const loadPermissionPicker = () =>
  import('./playground/PermissionPickerPreview.svelte');
const loadStyleless = () => import('./playground/StylelessPreview.svelte');

export default {
  packageName: '@happyvertical/smrt-ui',
  displayName: 'UI Foundation',
  description:
    'Provider-free controls and data primitives rendered in the active s-m-r-t theme.',
  entries: [
    {
      id: 'permission-picker',
      title: 'Permission Picker',
      description:
        'Grouped, searchable native-form permission grants with retained server retry selections.',
      loadComponent: loadPermissionPicker,
      order: 9,
      tags: ['forms', 'permissions', 'roles', 'search'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'code-selectors',
      title: 'Currency, Country & Province',
      description:
        'Localized code choices, retained values, and free-text regions.',
      loadComponent: () => import('./playground/CodeSelectorsPreview.svelte'),
      order: 8,
      tags: ['forms', 'currency', 'address'],
      modes: { mock: { label: 'Interactive' } },
    },
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
    {
      id: 'styleless-mode',
      title: 'Styleless Mode',
      description:
        'Toggle unstyled.css across the catalogue: components keep layout and drop their themed look, so consumer CSS can restyle them.',
      loadComponent: loadStyleless,
      order: 10,
      tags: ['styling', 'styleless', 'layers', 'restyling'],
      modes: { mock: { label: 'Interactive' } },
    },
    {
      id: 'touch-tools',
      title: 'Touch Keypad & Document Viewer',
      description:
        'Glove-sized number/money keypad with integer minor units, and a pinch-zoom document viewer that reads files through an injected fetch.',
      loadComponent: loadTouchTools,
      order: 11,
      tags: ['forms', 'touch', 'keypad', 'money', 'pdf', 'viewer'],
      modes: { mock: { label: 'Interactive' } },
    },
  ],
};
