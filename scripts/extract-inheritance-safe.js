import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const inhOutputPath = 'packages/core/src/registry/inheritance-resolver.ts';

let registryContent = fs.readFileSync(registryPath, 'utf8');

function extractMethod(
  content,
  methodSignatureRegex,
  nextMethodSignatureRegex,
) {
  const startMatch = content.match(methodSignatureRegex);
  if (!startMatch)
    throw new Error(`Could not find start: ${methodSignatureRegex}`);
  const startIdx = startMatch.index;

  const _endMatch = content.match(nextMethodSignatureRegex);
  // We'll search from startIdx
  const subContent = content.substring(startIdx);
  const endMatch2 = subContent.match(nextMethodSignatureRegex);
  if (!endMatch2)
    throw new Error(`Could not find end: ${nextMethodSignatureRegex}`);

  const endIdx = startIdx + endMatch2.index;

  // Actually, wait, it's safer to just substring until the next known element.
  // BUT what if there are comments before the next method?
  // We can backtrack to the previous '}'
  let realEndIdx = endIdx;
  while (realEndIdx > startIdx && content[realEndIdx] !== '}') {
    realEndIdx--;
  }
  return content.substring(startIdx, realEndIdx + 1);
}

// 1. getInheritanceChain
// static getInheritanceChain(className: string): string[] { ... }
// next: static async getAllFields(
const getInheritanceChainStr = extractMethod(
  registryContent,
  /static getInheritanceChain\(/,
  /static async getAllFields\(/,
);

// 2. getAllFields
// static async getAllFields(className: string): Promise<Map<string, any>> { ... }
// next: private static mergeFieldConfigs(
const getAllFieldsStr = extractMethod(
  registryContent,
  /static async getAllFields\(/,
  /private static mergeFieldConfigs\(/,
);

// 3. mergeFieldConfigs
// private static mergeFieldConfigs( ... )
// next: static async getAllMethods(
const mergeFieldConfigsStr = extractMethod(
  registryContent,
  /private static mergeFieldConfigs\(/,
  /static async getAllMethods\(/,
);

// 4. getAllMethods
// static async getAllMethods(className: string): Promise<Map<string, any>> { ... }
// next: static getObjectMetadata(
const getAllMethodsStr = extractMethod(
  registryContent,
  /static async getAllMethods\(/,
  /static getObjectMetadata\(/,
);

function replaceObjectRegistryInh(body) {
  return body
    .replace(
      /ObjectRegistry\.getInheritanceCache\(\)/g,
      'getInheritanceCache()',
    )
    .replace(/ObjectRegistry\.findClassStrict/g, 'findClassStrict')
    .replace(/ObjectRegistry\.findClass/g, 'findClass')
    .replace(/ObjectRegistry\.mergeFieldConfigs/g, 'mergeFieldConfigs')
    .replace(/ObjectRegistry\.getInheritanceChain/g, 'getInheritanceChain')
    .replace(
      /ObjectRegistry\.ensureManifestLoaded/g,
      'ObjectRegistry.ensureManifestLoaded',
    );
}

const getInheritanceChainBody = replaceObjectRegistryInh(
  getInheritanceChainStr,
).replace(
  /static getInheritanceChain\(/g,
  'export function getInheritanceChain(',
);

const getAllFieldsBody = replaceObjectRegistryInh(getAllFieldsStr).replace(
  /static async getAllFields\(/g,
  'export async function getAllFields(',
);

const mergeFieldConfigsBody = replaceObjectRegistryInh(
  mergeFieldConfigsStr,
).replace(
  /private static mergeFieldConfigs\(/g,
  'export function mergeFieldConfigs(',
);

const getAllMethodsBody = replaceObjectRegistryInh(getAllMethodsStr).replace(
  /static async getAllMethods\(/g,
  'export async function getAllMethods(',
);

// Add missing imports to inheritance-resolver.ts
let inhFileContent = fs.readFileSync(inhOutputPath, 'utf8');

const newImports = `import { ObjectRegistry } from '../registry';
import {
  getInheritanceCache,
  getInheritanceConfig,
  verboseLog,
} from './shared-state';
import {
  findClass,
  findClassStrict,
} from './name-resolver';\n\n`;

// Only add if not already added
if (!inhFileContent.includes("import { ObjectRegistry } from '../registry';")) {
  inhFileContent = inhFileContent.replace(
    "import type { SmrtObject } from '../object';",
    `import type { SmrtObject } from '../object';\n${newImports}`,
  );
}

// Ensure we don't duplicate appending
if (!inhFileContent.includes('export function getInheritanceChain')) {
  inhFileContent += `\n${getInheritanceChainBody}\n\n${getAllFieldsBody}\n\n${mergeFieldConfigsBody}\n\n${getAllMethodsBody}\n`;
  fs.writeFileSync(inhOutputPath, inhFileContent);
  console.log('Successfully updated inheritance-resolver.ts');
}

// Update registry.ts with delegates
const replacements = [
  [
    getInheritanceChainStr,
    `  static getInheritanceChain(className: string): string[] {
    return _getInheritanceChain(className);
  }`,
  ],
  [
    getAllFieldsStr,
    `  static async getAllFields(className: string): Promise<Map<string, any>> {
    return _getAllFields(className);
  }`,
  ],
  [
    mergeFieldConfigsStr,
    `  private static mergeFieldConfigs(
    parentField: any,
    childField: any,
    fieldName: string,
  ): any {
    return _mergeFieldConfigs(parentField, childField, fieldName);
  }`,
  ],
  [
    getAllMethodsStr,
    `  static async getAllMethods(className: string): Promise<Map<string, any>> {
    return _getAllMethods(className);
  }`,
  ],
];

for (const [oldStr, newStr] of replacements) {
  registryContent = registryContent.replace(oldStr, newStr);
}

const imports =
  'import { ' +
  '\n' +
  '  getInheritanceChain as _getInheritanceChain,' +
  '\n' +
  '  getAllFields as _getAllFields,' +
  '\n' +
  '  mergeFieldConfigs as _mergeFieldConfigs,' +
  '\n' +
  '  getAllMethods as _getAllMethods,' +
  '\n' +
  "} from './registry/inheritance-resolver';\n";

if (!registryContent.includes('_getInheritanceChain')) {
  registryContent = registryContent.replace(
    'import { \n  register as _register,',
    `${imports}import { \n  register as _register,`,
  );
  fs.writeFileSync(registryPath, registryContent);
  console.log('Successfully updated registry.ts');
}
