import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('timesheets', {
  entries: ['ui', 'attendance', 'rollup'],
  svelte: 'svelte',
});
