import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('inference', {
  entries: ['node', 'resolver', 'models', 'server'],
  svelte: 'svelte',
});
