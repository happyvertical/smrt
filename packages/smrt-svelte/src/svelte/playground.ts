export default {
  packageName: '@happyvertical/smrt-svelte',
  displayName: 'Svelte Integration',
  entries: [
    {
      id: 'shell-styleless',
      title: 'Styleless Shell',
      description:
        'Shell regions, drawers, and sorted components nested in Card slots.',
      loadComponent: () => import('./playground/ShellStylelessPreview.svelte'),
      tags: ['shell', 'styling', 'unstyled'],
      modes: { mock: { label: 'Interactive' } },
    },
  ],
};
