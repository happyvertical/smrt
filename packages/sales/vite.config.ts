import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('sales', {
  svelte: 'svelte',
  entries: ['agreements', 'crm', 'referrals', 'commissions'],
});
