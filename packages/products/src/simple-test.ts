/**
 * Simple test without complex dependencies
 * Tests the AST scanner directly
 */

import { resolve } from 'node:path';
import {
  ASTScanner,
  ManifestGenerator,
} from '@happyvertical/smrt-core/scanner';

async function testAST() {
  console.log('🔍 Testing AST Scanner...');

  const testFile = resolve('./src/models.ts');
  console.log('Scanning:', testFile);

  try {
    const scanner = new ASTScanner([testFile]);
    const results = scanner.scanFiles();

    console.log('📊 Scan Results:');
    results.forEach((result) => {
      console.log(`  File: ${result.filePath}`);
      console.log(`  Objects found: ${result.objects.length}`);
      console.log(`  Errors: ${result.errors.length}`);

      result.objects.forEach((obj) => {
        console.log(`    - ${obj.className} (${obj.collection})`);
        console.log(`      Fields: ${Object.keys(obj.fields).join(', ')}`);
        console.log('      Config:', obj.decoratorConfig);
      });
    });

    // Generate manifest
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);

    console.log('\n📄 Generated Manifest:');
    console.log(JSON.stringify(manifest, null, 2));

    // Generate virtual modules content
    console.log('\n🔧 Generated REST Endpoints:');
    const endpoints = generator.generateRestEndpoints(manifest);
    console.log(endpoints);

    console.log('\n🤖 Generated MCP Tools:');
    const tools = generator.generateMCPTools(manifest);
    console.log(tools);

    console.log('\n✅ AST Scanner test completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testAST();
