import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-workbench', {
  entries: ['vite', 'runtime'],
  svelte: 'svelte',
});
