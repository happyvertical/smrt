import { createPackageConfig } from '../../vite.config.base';

// `cli` and `types` are additional entries beyond the default `index`.
// `types` is auto-detected by createPackageConfig when src/types.ts exists.
export default createPackageConfig('scanner', {
  entries: ['cli'],
});
