import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('manufacturing', {
  entries: ['ui', 'views'],
  svelte: 'svelte',
});
