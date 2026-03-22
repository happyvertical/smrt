import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('tenancy', {
  entries: [
    'testing',
    'ui',
    'playground',
    {
      name: 'adapters/index',
      source: 'src/adapters/index.ts',
    },
  ],
  svelte: 'svelte',
});
