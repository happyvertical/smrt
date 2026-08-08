/**
 * Field-policy playground previews (#2048).
 *
 * Registered with the shared playground host via the auto-discovered
 * "packages/STAR/src/svelte/playground.ts" convention (smrt-playground vite
 * plugin).
 */
const loadFieldPolicyForm = () =>
  import('./playground/FieldPolicyFormPreview.svelte');
const loadObjectForm = () => import('./playground/ObjectFormPreview.svelte');

export default {
  packageName: '@happyvertical/smrt-fields',
  displayName: 'Field Policies',
  description:
    'Headless form primitives: FieldPolicyProvider, PolicyField, basic/advanced modes, and manifest-sourced help.',
  entries: [
    {
      id: 'policy-form',
      title: 'Policy-Driven Form',
      description:
        'A hand-written product form adopting PolicyField on a subset of fields — visibility by mode, default prefill, help hints, and the form-level glossary.',
      loadComponent: loadFieldPolicyForm,
      order: 1,
      tags: ['forms', 'fields', 'policy', 'defaults'],
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'object-form',
      title: 'Generated ObjectForm',
      description:
        'A reusable create/edit form from generated web fields and resolved policy, including advanced groups and a per-field custom renderer.',
      loadComponent: loadObjectForm,
      order: 2,
      tags: ['forms', 'fields', 'object-form', 'registry'],
      modes: { mock: { label: 'Mock' } },
    },
  ],
};
