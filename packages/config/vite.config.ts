import { createPackageConfig } from '../../vite.config.base.js';

// `loader` and `loader.browser` are separate files so `package.json#browser`
// can swap one for the other (#2838): `dist/index.js` imports `./loader.js`
// instead of inlining it, and nothing imports the browser variant, so it
// needs its own entry to be emitted.
export default createPackageConfig('config', {
  entries: ['loader', 'loader.browser'],
});
