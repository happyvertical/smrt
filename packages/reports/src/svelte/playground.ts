import { client, proposal, result, saved } from './preview-data.js';

export default {
  packageName: '@happyvertical/smrt-reports',
  displayName: 'Reports',
  description: 'Saved runtime reports and live results.',
  entries: [
    {
      id: 'saved-reports',
      title: 'Saved reports',
      description:
        'Saved reports as cards, whose and archived filters, and archive in a menu.',
      loadComponent: () =>
        import('./SavedReports.svelte').then((m) => m.default),
      props: { client: client() },
      order: 1,
    },
    {
      id: 'report-detail',
      title: 'Report detail',
      description: 'Money values with chart and table views.',
      loadComponent: () =>
        import('./ReportDetail.svelte').then((m) => m.default),
      props: { id: saved.id, client: client(), locale: 'en-US' },
      order: 2,
    },
    {
      id: 'report-confirmation',
      title: 'Report confirmation',
      description: 'Review a bounded proposal before saving.',
      loadComponent: () =>
        import('./ReportConfirmation.svelte').then((m) => m.default),
      props: { proposal, confirm: async () => saved },
      order: 3,
    },
    {
      id: 'report-picker',
      title: 'Report picker',
      description: 'Choose a saved report and its measure.',
      loadComponent: () =>
        import('./ReportPicker.svelte').then((m) => m.default),
      props: {
        client: client(),
        reportId: saved.id,
        measure: 'total',
        dimension: 'region',
        onchange: () => {},
      },
      order: 4,
    },
    {
      id: 'reports-unavailable',
      title: 'Reports unavailable',
      description: 'Static hosts do not make server requests.',
      loadComponent: () =>
        import('./RuntimeReportsRoute.svelte').then((m) => m.default),
      props: { serverAvailable: false },
      order: 5,
    },
    {
      id: 'report-empty',
      title: 'Empty report',
      description: 'A valid report with no matching rows.',
      loadComponent: () =>
        import('./ReportResult.svelte').then((m) => m.default),
      props: { result: { ...result, rows: [], rowCount: 0 } },
      order: 6,
    },
  ],
};
