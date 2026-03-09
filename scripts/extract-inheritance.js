import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const outputPath = 'packages/core/src/registry/inheritance-resolver.ts';

const lines = fs.readFileSync(registryPath, 'utf8').split('\n');

const getLines = (start, end) => lines.slice(start - 1, end).join('\n');

function replaceObjectRegistryCalls(body) {
  return body
    .replace(
      /ObjectRegistry\.getInheritanceCache\(\)/g,
      'getInheritanceCache()',
    )
    .replace(/ObjectRegistry\.findClassStrict/g, 'findClassStrict')
    .replace(/ObjectRegistry\.findClass/g, 'findClass')
    .replace(/ObjectRegistry\.mergeFieldConfigs/g, 'mergeFieldConfigs')
    .replace(/ObjectRegistry\.getInheritanceChain/g, 'getInheritanceChain');
}

const getInheritanceChainBody = replaceObjectRegistryCalls(
  getLines(2225, 2321),
).replace(
  /static getInheritanceChain\(/g,
  'export function getInheritanceChain(',
);

const getAllFieldsBody = replaceObjectRegistryCalls(
  getLines(2333, 2407),
).replace(
  /static async getAllFields\(/g,
  'export async function getAllFields(',
);

const mergeFieldConfigsBody = replaceObjectRegistryCalls(
  getLines(2425, 2512),
).replace(
  /private static mergeFieldConfigs\(/g,
  'export function mergeFieldConfigs(',
);

const getAllMethodsBody = replaceObjectRegistryCalls(
  getLines(2534, 2583),
).replace(
  /static async getAllMethods\(/g,
  'export async function getAllMethods(',
);

// buildInheritanceChain is lines 3506 to 3536
const buildInheritanceChainBody = replaceObjectRegistryCalls(
  getLines(3506, 3536),
).replace(
  /private static buildInheritanceChain\(/g,
  'export function buildInheritanceChain(',
);

const fileContent = `/**
 * Inheritance resolution module for the SMRT ObjectRegistry.
 *
 * Handles building and caching inheritance chains, and resolving
 * inherited fields and methods from ancestors.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ConfigurationError } from '../errors';
import { SmrtObject } from '../object';
// Import ObjectRegistry for ensureManifestLoaded
import { ObjectRegistry } from '../registry';
import {
  getInheritanceCache,
  getInheritanceConfig,
  verboseLog,
} from './shared-state';
import {
  findClass,
  findClassStrict,
} from './name-resolver';

${getInheritanceChainBody}

${getAllFieldsBody}

${mergeFieldConfigsBody}

${getAllMethodsBody}

${buildInheritanceChainBody}
`;

fs.writeFileSync(outputPath, fileContent);
console.log('Successfully wrote inheritance-resolver.ts');

const registryContent = fs.readFileSync(registryPath, 'utf8');

const replacementGetInheritanceChain = `  static getInheritanceChain(className: string): string[] {
    return _getInheritanceChain(className);
  }`;

const replacementGetAllFields = `  static async getAllFields(className: string): Promise<Map<string, any>> {
    return _getAllFields(className);
  }`;

const replacementMergeFieldConfigs = `  private static mergeFieldConfigs(
    parentField: any,
    childField: any,
    fieldName: string,
  ): any {
    return _mergeFieldConfigs(parentField, childField, fieldName);
  }`;

const replacementGetAllMethods = `  static async getAllMethods(className: string): Promise<Map<string, any>> {
    return _getAllMethods(className);
  }`;

const replacementBuildInheritanceChain = `  private static buildInheritanceChain(ctor: typeof SmrtObject): string[] {
    return _buildInheritanceChain(ctor);
  }`;

let newRegistryContent = registryContent
  .replace(getLines(2225, 2321), replacementGetInheritanceChain)
  .replace(getLines(2333, 2407), replacementGetAllFields)
  .replace(getLines(2425, 2512), replacementMergeFieldConfigs)
  .replace(getLines(2534, 2583), replacementGetAllMethods)
  .replace(getLines(3506, 3536), replacementBuildInheritanceChain);

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
  '  buildInheritanceChain as _buildInheritanceChain,' +
  '\n' +
  "} from './registry/inheritance-resolver';\n";

newRegistryContent = newRegistryContent.replace(
  '// ── Extracted modules (Issue #1006) ──────────────────────────────────────\n',
  `// ── Extracted modules (Issue #1006) ──────────────────────────────────────\n${imports}`,
);

fs.writeFileSync(registryPath, newRegistryContent);
console.log('Successfully updated registry.ts');
