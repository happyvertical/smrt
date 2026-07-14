import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('profiles', {
  entries: [
    'utils',
    {
      name: 'internal/oidc-provisioning',
      source: 'src/internal/oidc-provisioning.ts',
    },
  ],
});
