/**
 * Site Configuration Helper
 *
 * Provides typed access to site configuration from smrt.config.js
 */

import { loadConfig, getSiteConfig, type SiteConfig } from '@happyvertical/smrt-config';

let _siteConfig: SiteConfig | null = null;

/**
 * Initialize and load site configuration
 * Call this in +layout.server.ts before accessing config
 */
export async function initSiteConfig(): Promise<SiteConfig> {
  if (!_siteConfig) {
    await loadConfig();
    _siteConfig = getSiteConfig();
  }
  if (!_siteConfig) {
    throw new Error('Site configuration not found in smrt.config.js. Ensure site: {} section exists.');
  }
  return _siteConfig;
}

/**
 * Get site configuration synchronously
 * Only call after initSiteConfig() has been called
 */
export function getSite(): SiteConfig {
  if (!_siteConfig) {
    throw new Error('Site config not initialized. Call initSiteConfig() in +layout.server.ts first.');
  }
  return _siteConfig;
}
