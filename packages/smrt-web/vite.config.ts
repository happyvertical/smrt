import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-web', {
  entries: ['webmcp', 'intents', 'webmcp-tool-names'],
});
