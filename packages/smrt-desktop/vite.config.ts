import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-desktop', {
  // Test-only fixtures must not ship as published types.
  dtsExclude: ['src/testing/**'],
});
