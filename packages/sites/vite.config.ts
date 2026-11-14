import { createPackageConfig } from '../../vite.config.base.js';

// `./hostname` is a dependency-free subpath so browser-safe consumers can
// import the helpers without loading the models.
export default createPackageConfig('sites', { entries: ['hostname'] });
