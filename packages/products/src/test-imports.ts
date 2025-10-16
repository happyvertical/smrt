/**
 * Test selective imports to avoid problematic dependencies
 */

import { ASTScanner } from '@smrt/core/scanner';
import { smrtPlugin } from '@smrt/core/vite-plugin';

console.log('✅ Workspace dependency resolution works!');
console.log('ASTScanner:', typeof ASTScanner);
console.log('smrtPlugin:', typeof smrtPlugin);
