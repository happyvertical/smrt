/**
 * Discovery module - Automatic manifest and object discovery
 */

export {
  autoDiscoverAndLoad,
  type DiscoveredManifest,
  discoverManifests,
  loadManifest,
  loadManifestFile,
  SmrtManifestNotBuiltError,
} from './manifest-discovery.js';
