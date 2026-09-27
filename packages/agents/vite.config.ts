import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('agents', {
  svelte: 'svelte',
  entries: [
    'playground',
    'summary-article',
    'ui',
    {
      name: 'vite-plugin',
      source: 'src/vite-plugin.ts',
    },
    {
      name: 'server',
      source: 'src/server/index.ts',
    },
    {
      name: 'server/action-types',
      source: 'src/server/action-types.ts',
    },
  ],
});
