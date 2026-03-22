import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('commerce', {
  entries: ['ui', 'playground'],
  svelte: 'svelte',
});
