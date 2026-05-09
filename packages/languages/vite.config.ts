import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('languages', {
  // Catch declaration regressions on the public API.
  strictDts: true,
});
