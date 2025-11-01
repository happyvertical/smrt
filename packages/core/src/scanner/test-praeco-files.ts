/**
 * Test scanner with praeco files to verify issue #166 fix
 */
import { ASTScanner } from './ast-scanner.js';

const praecoFiles = [
  '/Users/will/Work/happyvertical/repos/praeco/src/council.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/meeting.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/document.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/agenda.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/report.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/source.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/member.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/proof.ts',
  '/Users/will/Work/happyvertical/repos/praeco/src/proofs.ts',
];

console.log('Testing AST Scanner with praeco files...\n');

// Change to praeco directory so tsconfig.json is found
process.chdir('/Users/will/Work/happyvertical/repos/praeco');

const scanner = new ASTScanner(praecoFiles, {
  baseClasses: ['SmrtObject', 'SmrtCollection'],
  includePrivateMethods: false,
  includeStaticMethods: true,
  followImports: false,
});

const results = scanner.scanFiles();

console.log(`\n=== SCAN RESULTS ===`);
console.log(`Total files scanned: ${results.length}`);

const allObjects: string[] = [];
for (const result of results) {
  for (const obj of result.objects) {
    allObjects.push(obj.name);
    console.log(
      `✅ Found: ${obj.className} (${obj.name}) from ${result.filePath.split('/').pop()}`,
    );
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total SMRT objects found: ${allObjects.length}`);
console.log(`Objects: ${allObjects.join(', ')}`);

const expected = [
  'council',
  'meeting',
  'document',
  'agenda',
  'praecoreport',
  'praecosource',
  'councilmember',
  'proof',
  'proofs',
  'councils',
  'meetings',
];
const missing = expected.filter((name) => !allObjects.includes(name));

if (missing.length === 0) {
  console.log('\n✅ SUCCESS: All expected objects found!');
  process.exit(0);
} else {
  console.log(`\n❌ FAILURE: Missing objects: ${missing.join(', ')}`);
  process.exit(1);
}
