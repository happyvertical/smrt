import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('sales', {
  svelte: 'svelte',
  entries: ['crm', 'referrals', 'commissions'],
});
