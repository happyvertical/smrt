import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('agents', {
  svelte: 'svelte',
  entries: [
    'playground',
    'ui',
    {
      name: 'vite-plugin',
      source: 'src/vite-plugin.ts',
    },
    {
      name: 'server',
      source: 'src/server/index.ts',
    },
  ],
});
