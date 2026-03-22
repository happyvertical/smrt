import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('users', {
  entries: ['sveltekit', 'ui', 'playground'],
  svelte: 'svelte',
});
