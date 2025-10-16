/**
 * Test selective imports to avoid problematic dependencies
 */

import { ASTScanner } from '@have/smrt/scanner';
import { smrtPlugin } from '@have/smrt/vite-plugin';

console.log('✅ Workspace dependency resolution works!');
console.log('ASTScanner:', typeof ASTScanner);
console.log('smrtPlugin:', typeof smrtPlugin);
