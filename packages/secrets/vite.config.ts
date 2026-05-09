import { createPackageConfig } from '../../vite.config.base.js';

// Multi-entry library exposing models/index and services/SecretService as
// subpath exports. smrtPlugin is auto-injected by createPackageConfig().
export default createPackageConfig('secrets', {
  entries: [
    { name: 'models/index', source: 'src/models/index.ts' },
    { name: 'services/SecretService', source: 'src/services/SecretService.ts' },
  ],
});
