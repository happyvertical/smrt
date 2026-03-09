import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const inhOutputPath = 'packages/core/src/registry/inheritance-resolver.ts';

const registryContent = fs.readFileSync(registryPath, 'utf8');
const lines = registryContent.split('\n');
const getLines = (start, end) => lines.slice(start - 1, end).join('\n');

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
    ); // leaving as is, we import ObjectRegistry
}

const getInheritanceChainBody = replaceObjectRegistryInh(
  getLines(2225, 2321),
).replace(
  /static getInheritanceChain\(/g,
  'export function getInheritanceChain(',
);

const getAllFieldsBody = replaceObjectRegistryInh(getLines(2333, 2407)).replace(
  /static async getAllFields\(/g,
  'export async function getAllFields(',
);

const mergeFieldConfigsBody = replaceObjectRegistryInh(
  getLines(2425, 2512),
).replace(
  /private static mergeFieldConfigs\(/g,
  'export function mergeFieldConfigs(',
);

const getAllMethodsBody = replaceObjectRegistryInh(
  getLines(2534, 2583),
).replace(
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

inhFileContent = inhFileContent.replace(
  "import type { SmrtObject } from '../object';",
  `import type { SmrtObject } from '../object';\n${newImports}`,
);

inhFileContent += `\n${getInheritanceChainBody}\n\n${getAllFieldsBody}\n\n${mergeFieldConfigsBody}\n\n${getAllMethodsBody}\n`;

fs.writeFileSync(inhOutputPath, inhFileContent);
console.log('Successfully updated inheritance-resolver.ts');

// Update registry.ts with delegates
let newRegistryContent = registryContent;

const replacements = [
  [
    getLines(2225, 2321),
    `  static getInheritanceChain(className: string): string[] {
    return _getInheritanceChain(className);
  }`,
  ],
  [
    getLines(2333, 2407),
    `  static async getAllFields(className: string): Promise<Map<string, any>> {
    return _getAllFields(className);
  }`,
  ],
  [
    getLines(2425, 2512),
    `  private static mergeFieldConfigs(
    parentField: any,
    childField: any,
    fieldName: string,
  ): any {
    return _mergeFieldConfigs(parentField, childField, fieldName);
  }`,
  ],
  [
    getLines(2534, 2583),
    `  static async getAllMethods(className: string): Promise<Map<string, any>> {
    return _getAllMethods(className);
  }`,
  ],
];

for (const [oldStr, newStr] of replacements) {
  newRegistryContent = newRegistryContent.replace(oldStr, newStr);
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

newRegistryContent = newRegistryContent.replace(
  'import { \n  register as _register,',
  `${imports}import { \n  register as _register,`,
);

fs.writeFileSync(registryPath, newRegistryContent);
console.log('Successfully updated registry.ts');
