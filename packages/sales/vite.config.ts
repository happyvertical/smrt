import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('sales', {
  entries: ['ui'],
  svelte: 'svelte',
});