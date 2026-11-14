import { createPackageConfig } from '../../vite.config.base.js';

// `browser` is the `exports['.'].browser` entry: the config surface without
// the Node-only loader (cosmiconfig, jiti) (#3625). `deployment` is the compose
// deployment contract, a separate subpath with no loader dependency (#4789). `deployment-hosting` is its network half
// (GitHub declaration reader, HostedApp applier), kept out of the browser-safe
// entry (#4981).
export default createPackageConfig('config', {
  entries: ['browser', 'deployment', 'deployment-hosting'],
});
