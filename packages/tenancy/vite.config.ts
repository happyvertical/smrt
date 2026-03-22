import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('tenancy', {
  entries: ['testing', 'ui', 'playground'],
  entryPoints: {
    'adapters/index': 'src/adapters/index.ts',
  },
  svelte: 'svelte',
});
