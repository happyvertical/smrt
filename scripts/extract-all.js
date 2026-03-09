import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const regOutputPath = 'packages/core/src/registry/class-registration.ts';
const inhOutputPath = 'packages/core/src/registry/inheritance-resolver.ts';

const registryContent = fs.readFileSync(registryPath, 'utf8');
const lines = registryContent.split('\n');
const getLines = (start, end) => lines.slice(start - 1, end).join('\n');

function replaceObjectRegistryReg(body) {
  return body
    .replace(/ObjectRegistry\.classes/g, 'getClasses()')
    .replace(/ObjectRegistry\.collections/g, 'getCollections()')
    .replace(/ObjectRegistry\.constructorIndex/g, 'getConstructorIndex()')
    .replace(
      /ObjectRegistry\.collectionTableNames/g,
      'getCollectionTableNames()',
    )
    .replace(/ObjectRegistry\.stiSiblingsLoaded/g, 'getStiSiblingsLoaded()')
    .replace(/ObjectRegistry\.fieldDecorators/g, 'getFieldDecorators()')
    .replace(/ObjectRegistry\.classNameMap/g, 'getClassNameMap()')
    .replace(
      /ObjectRegistry\.getInheritanceCache\(\)/g,
      'getInheritanceCache()',
    )
    .replace(
      /ObjectRegistry\.getDiscoveryAttemptCache\(\)/g,
      'getDiscoveryAttemptCache()',
    )
    .replace(/ObjectRegistry\.findClass/g, 'findClass')
    .replace(
      /ObjectRegistry\.hasClassCaseInsensitive/g,
      'hasClassCaseInsensitive',
    )
    .replace(/ObjectRegistry\.addToClassNameMap/g, 'addToClassNameMap')
    .replace(/ObjectRegistry\.getCanonicalClassName/g, 'getCanonicalClassName')
    .replace(
      /ObjectRegistry\.removeFromClassNameMap/g,
      'removeFromClassNameMap',
    )
    .replace(
      /ObjectRegistry\.resolveManifestCollision/g,
      'resolveManifestCollision',
    )
    .replace(/ObjectRegistry\.registerFromManifest/g, 'registerFromManifest')
    .replace(/ObjectRegistry\.register\(/g, 'register(')
    .replace(/ObjectRegistry\.compileValidators/g, 'compileValidators')
    .replace(/ObjectRegistry\.buildInheritanceChain/g, 'buildInheritanceChain')
    .replace(/ObjectRegistry\.qualifyExtendsName/g, 'qualifyExtendsName');
}

const registerBody = replaceObjectRegistryReg(getLines(432, 1231)).replace(
  /static register\(/g,
  'export function register(',
);

const registerCollectionBody = replaceObjectRegistryReg(
  getLines(1243, 1253),
).replace(
  /static registerCollection\(/g,
  'export function registerCollection(',
);

const resolveCollisionBody = replaceObjectRegistryReg(
  getLines(1285, 1338),
).replace(
  /private static resolveManifestCollision\(/g,
  'export function resolveManifestCollision(',
);

const registerFromManifestBody = replaceObjectRegistryReg(
  getLines(1339, 1663),
).replace(
  /static registerFromManifest\(/g,
  'export function registerFromManifest(',
);

const regFileContent = `/**
 * Class registration module for the SMRT ObjectRegistry.
 *
 * Handles registering classes, collections, and manifest entries.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import { SmrtCollection } from '../collection';
import { ConfigurationError } from '../errors';
import {
  discoverSTISiblingsSync,
  getPackageName,
  discoverManifestSync,
  lookupInManifest,
} from '../manifest/manifest-loader.js';
import { SmrtObject } from '../object';
import {
  getClasses,
  getCollections,
  getConstructorIndex,
  getFieldDecorators,
  getStiSiblingsLoaded,
  getSourceFileFromStack,
  verboseLog,
} from './shared-state';
import type { RegisteredClass, SmartObjectConfig, SmrtObjectConstructor, ValidatorFunction } from './types.js';
import {
  addToClassNameMap,
  findClass,
  getCanonicalClassName,
  hasClassCaseInsensitive,
  qualifyExtendsName,
  removeFromClassNameMap,
} from './name-resolver';
import { buildInheritanceChain } from './inheritance-resolver';
import { compileValidators } from './validator';
import type { QualifiedClassName, SmrtVisibility } from '../scanner/types.js';
import type { SchemaDefinition, ColumnDefinition } from '../schema/types.js';
import { tableNameFromClass } from '../utils';
import { createQualifiedName, isQualifiedName } from '../utils/qualified-names.js';

${registerBody}

${registerCollectionBody}

${resolveCollisionBody}

${registerFromManifestBody}
`;
fs.writeFileSync(regOutputPath, regFileContent);

function replaceObjectRegistryInh(body) {
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

const buildInheritanceChainBody = replaceObjectRegistryInh(
  getLines(3506, 3536),
).replace(
  /private static buildInheritanceChain\(/g,
  'export function buildInheritanceChain(',
);

const inhFileContent = `/**
 * Inheritance resolution module for the SMRT ObjectRegistry.
 *
 * Handles building and caching inheritance chains, and resolving
 * inherited fields and methods from ancestors.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ConfigurationError } from '../errors';
import { SmrtObject } from '../object';
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
fs.writeFileSync(inhOutputPath, inhFileContent);

// Update registry.ts with delegates
let newRegistryContent = registryContent;

const replacements = [
  [
    getLines(432, 1231),
    `  static register(
    ctor: typeof SmrtObject,
    config: SmartObjectConfig = {},
  ): void {
    _register(ctor, config);
  }`,
  ],
  [
    getLines(1243, 1253),
    `  static registerCollection(
    objectName: string,
    collectionConstructor: new (options: any) => SmrtCollection<any>,
  ): void {
    _registerCollection(objectName, collectionConstructor);
  }`,
  ],
  [
    getLines(1285, 1338),
    `  private static resolveManifestCollision(
    name: string,
    objectDef: any,
    packageName: string | undefined,
    existing: RegisteredClass,
    existingKey: string,
  ): 'child-wins' | 'skip' {
    return _resolveManifestCollision(name, objectDef, packageName, existing, existingKey);
  }`,
  ],
  [
    getLines(1339, 1663),
    `  static registerFromManifest(
    name: string,
    objectDef: any,
    packageName?: string,
  ): void {
    _registerFromManifest(name, objectDef, packageName);
  }`,
  ],
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
  [
    getLines(3506, 3536),
    `  private static buildInheritanceChain(ctor: typeof SmrtObject): string[] {
    return _buildInheritanceChain(ctor);
  }`,
  ],
];

for (const [oldStr, newStr] of replacements) {
  newRegistryContent = newRegistryContent.replace(oldStr, newStr);
}

const imports =
  'import { ' +
  '\n' +
  '  register as _register,' +
  '\n' +
  '  registerCollection as _registerCollection,' +
  '\n' +
  '  registerFromManifest as _registerFromManifest,' +
  '\n' +
  '  resolveManifestCollision as _resolveManifestCollision,' +
  '\n' +
  "} from './registry/class-registration';\n" +
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
console.log('Successfully completed full extraction cycle.');
