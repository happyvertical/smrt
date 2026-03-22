import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('events', {
  entries: ['utils', 'ui', 'playground'],
  svelte: 'svelte',
});
