import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('reports', {
  svelte: 'svelte',
  entries: [
    'playground',
    'aggregate',
    'compiler',
    'decorators',
    'refresh',
    'scheduler',
    'state',
  ],
});
