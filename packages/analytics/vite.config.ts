import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('analytics', {
  entries: ['playground', 'ui'],
  svelte: 'svelte',
});
