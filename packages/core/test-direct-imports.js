#!/usr/bin/env node

/**
 * Test direct imports from the built @have/smrt package
 * This verifies all subpath exports are working correctly
 */

const imports = [
  { name: 'main index', path: './dist/index.js' },
  { name: 'utils', path: './dist/utils.js' },
  { name: 'generators/index', path: './dist/generators/index.js' },
  { name: 'generators/cli', path: './dist/generators/cli.js' },
  { name: 'generators/rest', path: './dist/generators/rest.js' },
  { name: 'generators/mcp', path: './dist/generators/mcp.js' },
  { name: 'generators/swagger', path: './dist/generators/swagger.js' },
  { name: 'manifest/index', path: './dist/manifest/index.js' },
  { name: 'vite-plugin/index', path: './dist/vite-plugin/index.js' },
  { name: 'runtime/index', path: './dist/runtime/index.js' }
];

console.log('Testing direct imports from @have/smrt package...\n');

let successful = 0;
let failed = 0;

for (const imp of imports) {
  try {
    await import(imp.path);
    console.log(`✅ ${imp.name}: SUCCESS`);
    successful++;
  } catch (error) {
    console.log(`❌ ${imp.name}: FAILED`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

console.log(`\n📊 Results: ${successful}/${imports.length} imports successful`);

if (failed === 0) {
  console.log('🎉 All subpath exports working correctly!');
  process.exit(0);
} else {
  console.log(`💥 ${failed} import(s) still failing`);
  process.exit(1);
}