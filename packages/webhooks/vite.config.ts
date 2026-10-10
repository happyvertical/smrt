import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('webhooks', {
  entries: ['admin'],
  svelte: 'svelte',
});
