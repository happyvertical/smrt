import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('chat', {
  entries: ['ui', 'playground'],
  svelte: 'svelte',
});
