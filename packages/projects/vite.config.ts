import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('projects', {
  entries: ['ui', 'playground'],
  svelte: 'svelte',
});
