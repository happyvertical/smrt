import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-desktop', {
  // Browser-safe entry for the signed-in desktop webview: no Node built-ins.
  entries: [{ name: 'webview', source: 'src/webview/index.ts' }],
  // Test-only fixtures must not ship as published types.
  dtsExclude: ['src/testing/**'],
});
