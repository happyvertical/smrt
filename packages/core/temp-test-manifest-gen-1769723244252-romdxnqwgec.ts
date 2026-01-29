
import { ManifestBuilder } from './src/manifest/generator.js';

const builder = new ManifestBuilder();

await builder.generate({
  // === FILE DISCOVERY ===
  // Scan all source files including test files for test manifest
  // Test classes defined inline need to be in the manifest for proper field detection
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.d.ts', 'node_modules/**'],

  // === SCANNER CONFIGURATION ===
  baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
  followImports: true,  // Needed for multi-package inheritance (e.g., Meeting extends Event from external package)
  loadViteConfig: true,  // Use custom baseClasses from vite.config.ts if present
  discoverExternalPackages: true,
  includeExternalBaseClasses: true,  // Test manifest needs external base classes

  // === OUTPUT CONFIGURATION ===
  outputDir: 'src/manifest',
  outputName: 'test-manifest.json',
  generateTypeStub: true,
  stubName: 'test-manifest-stub.ts',

  // === METADATA ===
  injectPackageInfo: true,
  moduleType: 'smrt',
});
