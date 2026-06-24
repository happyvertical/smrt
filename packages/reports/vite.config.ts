import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('reports', {
  entries: ['aggregate', 'compiler', 'decorators'],
});
