import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('social', {
  entries: ['server'],
  svelte: 'svelte',
});
