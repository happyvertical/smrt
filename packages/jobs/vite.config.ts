import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('jobs', {
  svelte: 'svelte',
  entries: ['runner', 'ui', 'playground', 'worker-liveness-thread'],
});
