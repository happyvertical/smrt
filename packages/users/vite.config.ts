import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('users', {
  entries: ['app-contract', 'sveltekit', 'ui', 'playground'],
  svelte: 'svelte',
});
