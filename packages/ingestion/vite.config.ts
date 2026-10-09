import { createPackageConfig } from '../../vite.config.base.js';
export default createPackageConfig('ingestion', {
  entries: ['dto', 'models', 'server', 'extraction-worker', 'execution'],
  dtsExclude: ['src/test-support/**'],
});
