import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('commerce', {
  entries: ['ui', 'playground', 'invoices', 'cost-billing', 'money'],
  svelte: 'svelte',
});
