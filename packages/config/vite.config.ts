import { createPackageConfig } from '../../vite.config.base.js';

// `browser` is the `exports['.'].browser` entry: the config surface without
// the Node-only loader (cosmiconfig, jiti) (#3625).
export default createPackageConfig('config', { entries: ['browser'] });
