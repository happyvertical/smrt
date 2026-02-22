import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('commerce', {
  entries: ['ui'],
  svelte: 'svelte',
});
