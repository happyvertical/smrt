import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const outputPath = 'packages/core/src/registry/class-registration.ts';

const lines = fs.readFileSync(registryPath, 'utf8').split('\n');

const getLines = (start, end) => lines.slice(start - 1, end).join('\n');

// Replace standard ObjectRegistry property accessors with the new getter function calls
function replaceObjectRegistryCalls(body) {
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

const registerBody = replaceObjectRegistryCalls(getLines(432, 1231)).replace(
  /static register\(/g,
  'export function register(',
);

const registerCollectionBody = replaceObjectRegistryCalls(
  getLines(1243, 1253),
).replace(
  /static registerCollection\(/g,
  'export function registerCollection(',
);

const resolveCollisionBody = replaceObjectRegistryCalls(
  getLines(1285, 1338),
).replace(
  /private static resolveManifestCollision\(/g,
  'export function resolveManifestCollision(',
);

const registerFromManifestBody = replaceObjectRegistryCalls(
  getLines(1339, 1663),
).replace(
  /static registerFromManifest\(/g,
  'export function registerFromManifest(',
);

const fileContent = `/**
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

fs.writeFileSync(outputPath, fileContent);
console.log('Successfully wrote class-registration.ts');

const registryContent = fs.readFileSync(registryPath, 'utf8');

// The replacement bodies. We just delegate to the extracted functions.
const replacementRegister = `  static register(
    ctor: typeof SmrtObject,
    config: SmartObjectConfig = {},
  ): void {
    _register(ctor, config);
  }`;

const replacementRegisterCollection = `  static registerCollection(
    objectName: string,
    collectionConstructor: new (options: any) => SmrtCollection<any>,
  ): void {
    _registerCollection(objectName, collectionConstructor);
  }`;

const replacementResolveCollision = `  private static resolveManifestCollision(
    name: string,
    objectDef: any,
    packageName: string | undefined,
    existing: RegisteredClass,
    existingKey: string,
  ): 'child-wins' | 'skip' {
    return _resolveManifestCollision(name, objectDef, packageName, existing, existingKey);
  }`;

const replacementRegisterFromManifest = `  static registerFromManifest(
    name: string,
    objectDef: any,
    packageName?: string,
  ): void {
    _registerFromManifest(name, objectDef, packageName);
  }`;

let newRegistryContent = registryContent
  .replace(getLines(432, 1231), replacementRegister)
  .replace(getLines(1243, 1253), replacementRegisterCollection)
  .replace(getLines(1285, 1338), replacementResolveCollision)
  .replace(getLines(1339, 1663), replacementRegisterFromManifest);

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
  "} from './registry/class-registration';\n";

newRegistryContent = newRegistryContent.replace(
  '// ── Extracted modules (Issue #1006) ──────────────────────────────────────\n',
  `// ── Extracted modules (Issue #1006) ──────────────────────────────────────\n${imports}`,
);

fs.writeFileSync(registryPath, newRegistryContent);
console.log('Successfully updated registry.ts');
