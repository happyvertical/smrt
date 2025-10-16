/**
 * Test workspace dependency resolution
 */

import { resolve } from 'node:path';
import { ASTScanner, smrtPlugin } from '@have/smrt';

console.log('✅ Workspace dependency resolution works!');
console.log('ASTScanner:', typeof ASTScanner);
console.log('smrtPlugin:', typeof smrtPlugin);

// Quick test
const modelsFile = resolve('./src/models.ts');
const scanner = new ASTScanner([modelsFile]);
const results = scanner.scanFiles();

console.log(`Found ${results[0]?.objects.length || 0} SMRT objects`);
