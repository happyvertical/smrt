import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('human-resources', {
  entries: ['ui'],
  svelte: 'svelte',
});
