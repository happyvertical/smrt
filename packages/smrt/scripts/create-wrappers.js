#!/usr/bin/env node
/**
 * Create wrapper files for subpath exports
 *
 * The Vite build with preserveModules creates flat numbered files (index17.js, etc)
 * but package.json exports expect directory structure (vite-plugin/index.js, etc).
 * This script creates wrapper files that re-export from the main index.js.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '../dist');

// Map of subpath exports to their exported symbols
const wrappers = [
  {
    path: 'vite-plugin/index.js',
    exports: ['smrtPlugin'],
  },
  {
    path: 'consumer-plugin/index.js',
    exports: ['smrtConsumer'],
  },
  {
    path: 'runtime/index.js',
    exports: ['createMCPServer', 'createSmrtServer', 'createSmrtClient'],
  },
  {
    path: 'prebuild/index.js',
    exports: ['generateTypes', 'loadStaticManifest'],
  },
  {
    path: 'fields/index.js',
    exports: '*', // Re-export everything from fields
  },
  {
    path: 'generators/cli.js',
    exports: ['main'], // Import and run main for CLI
    isCLI: true,
  },
  {
    path: 'prebuild/cli.js',
    exports: '*', // Re-export everything for prebuild CLI
  },
];

// Create wrapper files
for (const wrapper of wrappers) {
  const wrapperPath = join(distDir, wrapper.path);
  const wrapperDir = dirname(wrapperPath);

  // Create directory if it doesn't exist
  mkdirSync(wrapperDir, { recursive: true });

  // Generate export statement
  const shebang = wrapper.isCLI ? '#!/usr/bin/env node\n' : '';
  let content;

  if (wrapper.isCLI && wrapper.exports.includes('main')) {
    // CLI entry point - import and run main
    content = `${shebang}// Auto-generated CLI entry point
import { main } from '../index.js';

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
`;
  } else if (wrapper.exports === '*') {
    // Wildcard export
    content = `${shebang}// Auto-generated wrapper for subpath export
export * from '../index.js';
`;
  } else {
    // Named exports
    content = `${shebang}// Auto-generated wrapper for subpath export
export { ${wrapper.exports.join(', ')} } from '../index.js';
`;
  }

  // Write wrapper file
  writeFileSync(wrapperPath, content, 'utf-8');
  console.log(`✓ Created wrapper: ${wrapper.path}`);
}

console.log(`\n✅ Generated ${wrappers.length} wrapper files`);
