import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('messages', {
  entries: ['ui', 'playground'],
  svelte: 'svelte',
});
