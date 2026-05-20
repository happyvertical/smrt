/**
 * Class registration module for the SMRT ObjectRegistry.
 *
 * Handles registering classes, collections, and manifest entries.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import type { SmrtCollection } from '../collection';
import { ConfigurationError } from '../errors';
import {
  discoverManifestSync,
  discoverSTISiblingsSync,
  getPackageName,
  lookupInManifest,
} from '../manifest/manifest-loader.js';
import { cloneManifestSchemaColumns } from '../manifest/store.js';
import { SmrtObject } from '../object';
import type { QualifiedClassName, SmrtVisibility } from '../scanner/types.js';
import type { ColumnDefinition, SchemaDefinition } from '../schema/types.js';
import { tableNameFromClass, toSnakeCase } from '../utils';
import {
  createQualifiedName,
  isQualifiedName,
} from '../utils/qualified-names.js';
import {
  type CollisionInputs,
  decideCollisionPolicy,
  type MatchKind,
} from './collision-policy.js';
import { buildInheritanceChain } from './inheritance-resolver';
import {
  createFieldFromManifest,
  mergeManifestField,
} from './manifest-field-merge.js';
import {
  findClass,
  getCanonicalClassName,
  hasClassCaseInsensitive,
  qualifyExtendsName,
} from './name-resolver';
import {
  getClasses,
  getCollections,
  getConstructorIndex,
  getFieldDecorators,
  getInheritanceCache,
  getSourceFileFromStack,
  getStiSiblingsLoaded,
  verboseLog,
} from './shared-state';
import type {
  RegisteredClass,
  SmartObjectConfig,
  ValidatorFunction,
} from './types.js';
import { compileValidators } from './validator';

/**
 * Shared bundled-context detector. Source files in these output
 * directories come from a bundler (Vite library mode, webpack, Next.js,
 * Nuxt, svelte-kit) that can duplicate module code across chunks.
 */
function isBundledOutputPath(sourceFile: string | undefined): boolean {
  if (!sourceFile) return false;
  return (
    sourceFile.includes('.svelte-kit/output/') ||
    sourceFile.includes('/dist/') ||
    sourceFile.includes('/build/') ||
    sourceFile.includes('.next/') ||
    sourceFile.includes('.nuxt/')
  );
}

/**
 * Build `CollisionInputs` for the decorator-origin path (`register()`).
 * Manifest-origin inputs are built separately inside `registerFromManifest`.
 */
function buildDecoratorCollisionInputs(args: {
  ctor: typeof SmrtObject;
  name: string;
  newPackageName: string | undefined;
  newSourceFile: string | undefined;
  newInBundledContext: boolean;
  existing: RegisteredClass;
  existingKey: string;
  matchKind: MatchKind;
}): CollisionInputs {
  const {
    ctor,
    name,
    newPackageName,
    newSourceFile,
    newInBundledContext,
    existing,
    existingKey,
    matchKind,
  } = args;

  let newExtendsExisting = false;
  let existingExtendsNew = false;
  try {
    newExtendsExisting = ctor.prototype instanceof existing.constructor;
    existingExtendsNew = existing.constructor.prototype instanceof ctor;
  } catch {
    // `instanceof` can throw for non-function constructors. Keep both false.
  }

  const bothSourceFilesKnown = !!(newSourceFile && existing.sourceFilePath);
  const sameSourceFile =
    bothSourceFilesKnown && newSourceFile === existing.sourceFilePath;
  const existingIsPackageQualified = !!existing.packageName?.startsWith('@');
  const samePackage =
    !!newPackageName &&
    !!existing.packageName &&
    newPackageName === existing.packageName;
  const hasNewQualifiedKey = !!newPackageName;
  const existingKeyIsQualified = isQualifiedName(existingKey);

  return {
    origin: 'decorator',
    matchKind,
    sameConstructor: existing.constructor === ctor,
    sameSourceFile,
    bothSourceFilesKnown,
    existingIsManifestStub:
      (existing.constructor as { _isManifestStub?: boolean })
        ._isManifestStub === true,
    newInBundledContext,
    newExtendsExisting,
    existingExtendsNew,
    samePackage,
    existingIsPackageQualified,
    sameName: name === existing.name,
    hasNewQualifiedKey,
    existingKeyIsQualified,
    existingHasAnyPackage: !!existing.packageName,
    // Manifest-only fields; filled with safe defaults for decorator origin.
    hasManifestContent: false,
    registrationKeyDiffersFromExistingKey: false,
    existingHasNoPackage: !existing.packageName,
  };
}

/**
 * Execute the collision policy for `register()`. Returns `true` if the
 * policy resolved the collision (caller should return from `register`);
 * `false` means no policy match (the decision table is exhaustive so
 * that never actually happens — the default row throws).
 *
 * All state mutation (`upsertExistingEntry`, verboseLog) stays in this
 * caller-side helper; the policy function itself is pure.
 */
function applyRegisterCollisionPolicy(args: {
  ctor: typeof SmrtObject;
  name: string;
  newPackageName: string | undefined;
  newSourceFile: string | undefined;
  newInBundledContext: boolean;
  existing: RegisteredClass;
  existingKey: string;
  matchKind: MatchKind;
  upsertExistingEntry: (
    existingKey: string,
    existing: RegisteredClass,
  ) => string;
}): boolean {
  const inputs = buildDecoratorCollisionInputs(args);
  const decision = decideCollisionPolicy(inputs);

  switch (decision.policy) {
    case 'accept':
    case 'replace': {
      // Both map to the same operation for the decorator path:
      // update the existing slot's constructor + metadata. `replace`
      // only differs in verboseLog flavor so a reviewer reading the log
      // can tell which scenario fired.
      const newKey = args.upsertExistingEntry(args.existingKey, args.existing);
      if (
        decision.scenario === 'sti-child-wins' ||
        decision.scenario === 'manifest-stub-replacement'
      ) {
        verboseLog(
          `[registry] ${decision.scenario}: '${args.name}' → key='${newKey}' (${decision.reason})`,
        );
      }
      return true;
    }
    case 'skip':
      verboseLog(
        `[registry] ${decision.scenario}: skipping '${args.name}' (${decision.reason})`,
      );
      return true;
    case 'throw': {
      const matchSuffix =
        args.matchKind === 'case-insensitive'
          ? ` (case-insensitive match with "${args.existingKey}")`
          : '';
      throw new Error(
        `SMRT Class Name Collision: "${args.name}"${matchSuffix}\n\n` +
          `A class with this name is already registered, but with a different constructor.\n` +
          `This usually happens when:\n` +
          `  1. Multiple test files define classes with the same name\n` +
          `  2. Different packages export classes with the same name\n\n` +
          `The collision will cause the wrong field definitions to be used,\n` +
          `leading to properties not being initialized correctly.\n\n` +
          `To fix:\n` +
          `  - Use unique class names (e.g., ${args.name}_UniqueId)\n` +
          `  - Or use @smrt({ name: 'unique_name' }) to override the registration name`,
      );
    }
    case 'merge-manifest':
    case 'coexist-qualified':
      // These policies are only reachable from the manifest path; if we
      // somehow get here from `register()`, something is miswired.
      throw new Error(
        `decideCollisionPolicy returned '${decision.policy}' for decorator origin (scenario: ${decision.scenario}). This is a bug.`,
      );
  }
}

/**
 * Build `CollisionInputs` for the manifest-origin path
 * (`registerFromManifest`). Manifest entries have string-based inheritance
 * (`objectDef.extends`) rather than prototype-based, and no real
 * constructor to compare — `sameConstructor` is always false here.
 */
function buildManifestCollisionInputs(args: {
  name: string;
  objectDef: any;
  packageName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  registrationKey: string;
  matchKind: MatchKind;
}): CollisionInputs {
  const {
    name,
    objectDef,
    packageName,
    existing,
    existingKey,
    registrationKey,
    matchKind,
  } = args;
  const newClassName = objectDef.className || name;
  const newExtends = objectDef.extends as string | undefined;

  // When an incoming manifest's `extends` points at the existing entry,
  // OR the existing entry's `extends` points at the incoming class, we
  // have an STI inheritance relationship. Each side checks:
  //   - the simple name of the other
  //   - the key under which the other is registered
  //   - a case-insensitive fallback
  //
  // The `existingKey` comparison is load-bearing for cross-package STI:
  // `existing.extends` is stored post-`qualifyExtendsName()`, so it may
  // be the fully-qualified parent key like `@pkg:Parent`. Without this
  // comparison, `existingExtendsNew` falsely reads as false and the
  // arriving parent manifest would be registered as a duplicate instead
  // of skipped. See the deep-review report on #1140 for the fix rationale.
  const newExtendsExisting = !!(
    newExtends &&
    (newExtends === existing.name ||
      newExtends === existingKey ||
      newExtends.toLowerCase() === existing.name.toLowerCase())
  );
  const existingExtendsNew = !!(
    existing.extends &&
    (existing.extends === newClassName ||
      existing.extends === name ||
      existing.extends === registrationKey ||
      existing.extends.toLowerCase() === newClassName.toLowerCase())
  );

  const newSourceFile = objectDef.filePath as string | undefined;
  const bothSourceFilesKnown = !!(newSourceFile && existing.sourceFilePath);
  const sameSourceFile =
    bothSourceFilesKnown && newSourceFile === existing.sourceFilePath;
  const existingIsPackageQualified = !!existing.packageName?.startsWith('@');
  const samePackage =
    !!packageName &&
    !!existing.packageName &&
    packageName === existing.packageName;

  return {
    origin: 'manifest',
    matchKind,
    sameConstructor: false,
    sameSourceFile,
    bothSourceFilesKnown,
    existingIsManifestStub:
      (existing.constructor as { _isManifestStub?: boolean })
        ._isManifestStub === true,
    newInBundledContext: false,
    newExtendsExisting,
    existingExtendsNew,
    samePackage,
    existingIsPackageQualified,
    sameName: newClassName === existing.name,
    hasNewQualifiedKey: isQualifiedName(registrationKey),
    existingKeyIsQualified: isQualifiedName(existingKey),
    existingHasAnyPackage: !!existing.packageName,
    hasManifestContent: !!(
      objectDef.fields ||
      objectDef.methods ||
      objectDef.schema ||
      objectDef.decoratorConfig
    ),
    registrationKeyDiffersFromExistingKey: registrationKey !== existingKey,
    existingHasNoPackage: !existing.packageName,
  };
  // Note: manifest-origin sets hasNewQualifiedKey from the final
  // registrationKey (not packageName) because registerFromManifest accepts
  // an objectDef.qualifiedName fallback when packageName is omitted —
  // deriving from packageName alone would miss that case and misroute the
  // coexistence rows. See PR #1140 review (Copilot P1 at line 287).
}

/**
 * Execute the collision policy for `registerFromManifest()`. Returns
 * `'return'` when the policy fully resolves the collision (caller should
 * early-return from `registerFromManifest`) or `'continue'` when the new
 * registration should proceed to the fresh-entry code below the collision
 * block (either a child-wins delete-then-register or a different-package
 * coexist-qualified scenario).
 *
 * Implements the `merge-manifest` contract end-to-end: fold fields via
 * `mergeManifestIntoExistingRegistration`, then conditionally alias the
 * existing entry under `registrationKey` when it differs from the
 * canonical key — both steps preserve `issue-951:144-200`.
 */
function applyManifestCollisionPolicy(args: {
  name: string;
  objectDef: any;
  packageName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  registrationKey: string;
  matchKind: MatchKind;
}): 'return' | 'continue' {
  const inputs = buildManifestCollisionInputs(args);
  const decision = decideCollisionPolicy(inputs);

  switch (decision.policy) {
    case 'skip':
      verboseLog(
        `[registry] ${decision.scenario}: skipping manifest '${args.name}' (${decision.reason})`,
      );
      return 'return';
    case 'replace':
      // STI child-wins: delete existing so the new entry can register fresh.
      getClasses().delete(args.existingKey);
      verboseLog(
        `[registry] ${decision.scenario}: '${args.name}' replaces '${args.existingKey}' (${decision.reason})`,
      );
      return 'continue';
    case 'merge-manifest': {
      mergeManifestIntoExistingRegistration(
        args.existing,
        args.objectDef,
        args.packageName,
      );
      if (args.registrationKey !== args.existingKey) {
        const classes = getClasses();
        classes.set(args.registrationKey, args.existing);
        getConstructorIndex().set(
          args.existing.constructor,
          args.registrationKey,
        );
      }
      return 'return';
    }
    case 'coexist-qualified':
      // Both registrations live under their qualified keys; caller falls
      // through to register the new one fresh.
      return 'continue';
    case 'accept':
      // Manifest origin never returns 'accept' (that's a decorator-path
      // policy). Treat defensively as return-no-op.
      return 'return';
    case 'throw':
      // Manifest collisions default to skip, never throw — this branch is
      // unreachable from the manifest origin. Guard against future drift.
      throw new Error(
        `decideCollisionPolicy returned 'throw' for manifest origin (scenario: ${decision.scenario}). This is a bug.`,
      );
  }
}

function resolveTableName(
  ctor: typeof SmrtObject,
  name: string,
  config: SmartObjectConfig,
): string {
  const manifestEntry = config._manifest
    ? lookupInManifest(config._manifest, name)
    : discoverManifestSync(name);

  return (
    manifestEntry?.schema?.tableName ||
    manifestEntry?.decoratorConfig?.tableName ||
    config.tableName ||
    tableNameFromClass(ctor)
  );
}

function setSmrtTableName(ctor: typeof SmrtObject, tableName: string): void {
  const existing = Object.getOwnPropertyDescriptor(ctor, 'SMRT_TABLE_NAME');
  if (existing?.value === tableName) {
    return;
  }

  Object.defineProperty(ctor, 'SMRT_TABLE_NAME', {
    value: tableName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Attach the registry's qualified name to the constructor as a static
 * property. Mirrors the `SMRT_TABLE_NAME` pattern.
 *
 * Survives:
 * - Minification (the property is set on the constructor itself).
 * - HMR / module duplication / federated-module boundaries where the
 *   `constructorIndex` WeakMap holds an older constructor identity than
 *   the one a caller has in hand.
 *
 * Acts as a belt-and-suspenders fallback for runtime code that has a
 * constructor reference and wants its registry identity without going
 * through a Map lookup (e.g. `SmrtHierarchical._hierarchyCollection`).
 */
function setSmrtQualifiedName(
  ctor: typeof SmrtObject,
  qualifiedName: string | undefined,
): void {
  if (!qualifiedName) return;
  const existing = Object.getOwnPropertyDescriptor(ctor, '_smrtQualifiedName');
  if (existing?.value === qualifiedName) {
    return;
  }

  Object.defineProperty(ctor, '_smrtQualifiedName', {
    value: qualifiedName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

export function register(
  ctor: typeof SmrtObject,
  config: SmartObjectConfig = {},
): void {
  const name = config.name || ctor.name;
  const explicitPackageName = config.packageName;

  function upsertExistingEntry(
    existingKey: string,
    existing: RegisteredClass,
  ): string {
    const nextPackageName = explicitPackageName || existing.packageName;
    const nextKey = nextPackageName
      ? createQualifiedName(nextPackageName, name)
      : name;
    // Capture pre-mutation identity so descendants whose `extends` still
    // references the old name/qualifiedName are caught by the post-mutation
    // invalidation sweep (#1139 Gap 2).
    const previousIdentity = {
      name: existing.name,
      qualifiedName: existing.qualifiedName as string | undefined,
    };

    existing.name = name;
    existing.packageName = nextPackageName;
    existing.qualifiedName = nextPackageName
      ? (createQualifiedName(nextPackageName, name) as QualifiedClassName)
      : undefined;
    const nextTableName = resolveTableName(ctor, name, {
      ...existing.config,
      ...config,
    });
    existing.config = {
      ...existing.config,
      ...config,
      tableName: nextTableName,
    };
    if (!existing.schema) {
      existing.schema = {
        ddl: '',
        indexes: [],
        triggers: [],
        tableName: nextTableName,
        columns: {},
        foreignKeys: [],
        dependencies: [],
        version: '',
      };
    }
    existing.schema.tableName = nextTableName;
    existing.constructor = ctor;
    setSmrtTableName(ctor, nextTableName);
    setSmrtQualifiedName(ctor, existing.qualifiedName);

    if (existingKey !== nextKey) {
      const classes = getClasses();
      const existingAtNextKey = classes.get(nextKey);

      if (existingAtNextKey && existingAtNextKey !== existing) {
        throw new ConfigurationError(
          `Class registry collision while promoting "${existingKey}" to "${nextKey}". ` +
            'A different class is already registered under the target key.',
          'CONFIG_REGISTRY_PROMOTION_COLLISION',
          {
            existingKey,
            nextKey,
            className: name,
          },
        );
      }

      classes.delete(existingKey);
      classes.set(nextKey, existing);
    }

    getConstructorIndex().set(ctor, nextKey);

    // Release C follow-up #1139 Gap 2: we just mutated `existing.name`,
    // `existing.packageName`, `existing.qualifiedName`, `existing.config`,
    // `existing.constructor`, and `existing.schema.tableName`. Any
    // descendant whose cached `inheritedFields` was computed against the
    // prior identity now carries stale data. Invalidate `existing` and
    // every descendant whose `extends` matches the pre- or post-mutation
    // identity so the next field read re-merges from the current state.
    invalidateInheritanceEntries(existing, previousIdentity);

    return nextKey;
  }

  // Release C (#1134): collision resolution for both exact-match and
  // case-insensitive paths now routes through decideCollisionPolicy, which
  // consolidates the 11-branch if/else tree from pre-C.
  const newSourceFile = getSourceFileFromStack();
  const newPackageName =
    explicitPackageName || getPackageName(ctor, true) || undefined;
  const newInBundledContext = isBundledOutputPath(newSourceFile);

  // 1. Exact-match check (existingKey === name)
  if (getClasses().has(name)) {
    const existing = getClasses().get(name);
    if (!existing) {
      throw new Error(
        `Registry inconsistency: ${name} exists in classes Map but get() returned undefined`,
      );
    }

    const handled = applyRegisterCollisionPolicy({
      ctor,
      name,
      newPackageName,
      newSourceFile,
      newInBundledContext,
      existing,
      existingKey: name,
      matchKind: 'exact-key',
      upsertExistingEntry,
    });
    if (handled) return;
  }

  // 2. Case-insensitive check for manifest stubs (Issue #531, #847) and
  //    other same-name-different-case collisions.
  const lowerName = name.toLowerCase();
  for (const [existingKey, existing] of getClasses().entries()) {
    const keyMatches = existingKey.toLowerCase() === lowerName;
    const nameMatches = existing.name?.toLowerCase() === lowerName;
    if (!(keyMatches || nameMatches) || existingKey === name) continue;

    const handled = applyRegisterCollisionPolicy({
      ctor,
      name,
      newPackageName,
      newSourceFile,
      newInBundledContext,
      existing,
      existingKey,
      matchKind: 'case-insensitive',
      upsertExistingEntry,
    });
    if (handled) return;
  }

  // CRITICAL: Capture package name NOW, while stack trace still shows external package
  // This is called from the @smrt() decorator during import, so the stack trace
  // includes the external package file path. Later calls won't have this context.
  // Skip registry check to avoid circular dependency - class isn't registered yet!
  // This solves issue #159 where external package manifests couldn't be loaded.
  const packageNameFromStack =
    explicitPackageName || getPackageName(ctor, true) || undefined;

  // Capture source file path for collision detection during module re-evaluation
  // (Issue #555: Test isolation - class name collision during vitest collection)
  const sourceFilePath = getSourceFileFromStack();

  // Get field definitions from manifest
  // Priority order (Issue #270 Phase 1 - synchronous manifest loading):
  // 1. Explicitly provided manifest (_manifest parameter)
  // 2. Test manifests (for test classes)
  // 3. Static manifests (for core framework classes)
  // 4. Cached external manifests (if already loaded)
  // For external packages not yet loaded, manifest discovery happens lazily during schema generation
  // Issue #713: Use lookupInManifest for qualified name support
  let manifestEntry: ReturnType<typeof lookupInManifest> | undefined;
  if (config._manifest) {
    manifestEntry = lookupInManifest(config._manifest, name);
  }
  if (!manifestEntry) {
    manifestEntry = discoverManifestSync(name);
  }
  const fields = new Map<string, any>();
  const methods = new Map<string, any>();
  let packageName: string | undefined;

  verboseLog(
    `[registry] Registering ${name}: manifestEntry =`,
    manifestEntry ? 'found' : 'not found',
  );
  if (manifestEntry?.fields) {
    verboseLog(
      `[registry] Manifest has ${Object.keys(manifestEntry.fields).length} fields:`,
      Object.keys(manifestEntry.fields),
    );
  }

  if (manifestEntry?.fields) {
    // Use manifest fields (from build-time AST scanning)
    // Store field definitions as plain objects with nested options
    for (const [fieldName, fieldDef] of Object.entries(
      manifestEntry.fields,
    ) as [string, import('../scanner/types.js').FieldDefinition][]) {
      // Build options object, only including defined values
      const options: any = { ...fieldDef._meta };
      if (fieldDef.required !== undefined) options.required = fieldDef.required;
      if (fieldDef.default !== undefined) options.default = fieldDef.default;
      if (fieldDef.description !== undefined)
        options.description = fieldDef.description;
      if (fieldDef.transient !== undefined)
        options.transient = fieldDef.transient;

      // Store field definition as plain object maintaining Field-like structure
      const field: any = {
        type: fieldDef.type,
      };

      // Only include options if not empty
      if (Object.keys(options).length > 0) {
        field._meta = options;
      }

      // Preserve top-level flags from manifest
      if (fieldDef.transient !== undefined) {
        field.transient = fieldDef.transient;
      }
      if (fieldDef.required !== undefined) {
        field.required = fieldDef.required;
      }

      // Hoist related to top level for relationship fields
      // Check both fieldDef.related (new manifests) and _meta.related (old manifests)
      if (fieldDef.related !== undefined) {
        field.related = fieldDef.related;
      } else if (options.related !== undefined) {
        field.related = options.related;
        delete field._meta?.related;
      }

      fields.set(fieldName, field);
    }

    verboseLog(
      `[registry] ✅ Loaded ${fields.size} fields for ${name} from manifest`,
    );

    // Use packageName from manifest if available, otherwise from stack trace
    // Priority: explicit manifest > manifestEntry > stack trace
    packageName =
      explicitPackageName ||
      config._manifest?.packageName ||
      manifestEntry.packageName ||
      packageNameFromStack;
  } else {
    // No manifest found yet - use package name from stack trace
    // This will be used later by ensureManifestLoaded() to load the external manifest
    verboseLog(
      `[registry] ⚠️  No manifest entry for ${name} - fields will be loaded later`,
    );
    packageName = packageNameFromStack;
  }

  // Apply decorator metadata to override/extend manifest fields
  // Decorators take priority over AST-scanned types (Issue #316)
  const decorators = getFieldDecorators().get(name);
  if (decorators && decorators.size > 0) {
    verboseLog(
      `[registry] Applying ${decorators.size} field decorators for ${name}`,
    );

    for (const [fieldName, decoratorOptions] of decorators) {
      const existingField = fields.get(fieldName);

      if (existingField) {
        // Merge decorator options with manifest field
        // Decorator type takes priority over AST-scanned type
        const mergedField: any = {
          type: decoratorOptions.type || existingField.type,
          _meta: {
            ...existingField._meta,
            ...decoratorOptions,
          },
        };

        // Remove 'type' from _meta if it was moved to top level
        if (mergedField._meta.type) {
          delete mergedField._meta.type;
        }

        // Preserve top-level flags (transient, required, etc.)
        if (decoratorOptions.transient !== undefined) {
          mergedField.transient = decoratorOptions.transient;
        } else if (existingField.transient !== undefined) {
          mergedField.transient = existingField.transient;
        }

        // Handle required flag: nullable fields should not be required
        if (decoratorOptions.nullable === true) {
          // Nullable explicitly set to true means field is NOT required
          mergedField.required = false;
          mergedField._meta.required = false;
        } else if (decoratorOptions.required !== undefined) {
          mergedField.required = decoratorOptions.required;
        } else if (existingField.required !== undefined) {
          mergedField.required = existingField.required;
        }

        // Hoist related to top level for relationship fields
        if (decoratorOptions.related !== undefined) {
          mergedField.related = decoratorOptions.related;
          delete mergedField._meta?.related;
        } else if (existingField.related !== undefined) {
          mergedField.related = existingField.related;
        }

        fields.set(fieldName, mergedField);
        verboseLog(
          `[registry]   ✅ Merged decorator for ${fieldName}: type=${mergedField.type}`,
        );
      } else {
        // Decorator for field not in manifest - add it
        const newField: any = {
          type: decoratorOptions.type || 'text',
          _meta: decoratorOptions,
        };

        // Set top-level flags from decorator options
        if (decoratorOptions.transient !== undefined) {
          newField.transient = decoratorOptions.transient;
        }
        // Handle required flag: nullable fields should not be required
        if (decoratorOptions.nullable === true) {
          newField.required = false;
          newField._meta.required = false;
        } else if (decoratorOptions.required !== undefined) {
          newField.required = decoratorOptions.required;
        }

        // Hoist related to top level for relationship fields (Issue #746)
        // This is critical for getRelationshipMap() to detect relationships
        if (decoratorOptions.related !== undefined) {
          newField.related = decoratorOptions.related;
          delete newField._meta?.related;
        }

        fields.set(fieldName, newField);
        verboseLog(
          `[registry]   ✅ Added field ${fieldName} from decorator: type=${decoratorOptions.type || 'text'}`,
        );
      }
    }
  }

  // Handle tenantScoped configuration (Issue #688)
  // External manifests can carry tenantScoped only in decoratorConfig, so
  // registration must honor the merged view rather than only explicit config.
  let tenantScopedConfig: RegisteredClass['tenantScopedConfig'] | undefined;
  const effectiveTenantScoped =
    config.tenantScoped ?? manifestEntry?.decoratorConfig?.tenantScoped;
  if (effectiveTenantScoped) {
    // Normalize boolean or object config into full options
    const tenantOpts =
      typeof effectiveTenantScoped === 'boolean' ? {} : effectiveTenantScoped;
    tenantScopedConfig = {
      mode: tenantOpts.mode ?? 'required',
      field: tenantOpts.field ?? 'tenantId',
      autoFilter: tenantOpts.autoFilter ?? true,
      autoPopulate: tenantOpts.autoPopulate ?? true,
      allowSuperAdminBypass: tenantOpts.allowSuperAdminBypass ?? false,
    };

    // Inject tenantId field if not already defined
    const fieldName = tenantScopedConfig.field;
    if (!fields.has(fieldName)) {
      fields.set(fieldName, {
        type: 'foreignKey',
        related: 'Tenant',
        required: tenantScopedConfig.mode === 'required',
        _meta: {
          reference: 'Tenant',
          sqlType: 'TEXT',
          __tenancy: {
            isTenantIdField: true,
            ...tenantScopedConfig,
          },
        },
      });
      verboseLog(
        `[registry] ✅ Injected ${fieldName} field for tenant-scoped class ${name}`,
      );
    }
  }

  if (manifestEntry?.methods) {
    // Load method definitions from manifest (for custom CLI/API/MCP generation)
    for (const [methodName, methodDef] of Object.entries(
      manifestEntry.methods,
    )) {
      methods.set(methodName, methodDef);
    }
  }

  // Also load methods from _manifestMethods in config (from consumer plugin register.js)
  // This is how external package methods are passed to the registry
  if ((config as any)._manifestMethods) {
    for (const [methodName, methodDef] of Object.entries(
      (config as any)._manifestMethods,
    )) {
      methods.set(methodName, methodDef);
    }
    verboseLog(
      `[registry] Loaded ${methods.size} methods for ${name} from _manifestMethods`,
    );
  }

  // Note: If manifest not found here, it will be loaded asynchronously when needed
  // via ensureManifestLoaded(). This allows decorators to remain synchronous while
  // supporting dynamic external package manifest loading.

  // Build inheritance chain from constructor (needed for STI table name resolution)
  const inheritanceChain = buildInheritanceChain(ctor);

  // Validate table strategy compatibility with parent (STI requirement)
  if (inheritanceChain.length > 1) {
    // This class has a parent - validate strategy compatibility
    const parentName = inheritanceChain[inheritanceChain.length - 2]; // Second-to-last is parent
    const parentEntry = findClass(parentName);

    if (parentEntry) {
      const parentStrategy = parentEntry.config?.tableStrategy || 'default';
      const childStrategy = config.tableStrategy; // Don't default - undefined means inherit

      // Only validate if child has an EXPLICIT strategy that differs from parent
      // undefined childStrategy means it will inherit from parent
      if (childStrategy !== undefined && parentStrategy !== childStrategy) {
        throw ConfigurationError.incompatibleStrategy(
          name,
          childStrategy,
          parentName,
          parentStrategy,
        );
      }
    }
  }

  // Defer schema generation until needed (generateSchema now uses dynamic import)
  // Store table name for lazy schema generation
  // Priority for STI: manifest's tableName > decorator config > derived from class name
  // The manifest's tableName is computed at build-time when full class hierarchy is known,
  // which correctly handles STI inheritance. The decorator may derive wrong tableName
  // if parent class isn't registered yet at decorator execution time.
  const tableName = resolveTableName(ctor, name, config);
  setSmrtTableName(ctor, tableName);

  // Load pre-generated schema from manifest if available, otherwise placeholder
  let schema: SchemaDefinition;
  if (manifestEntry?.schema) {
    // Pre-generated schema from manifest (build-time)
    // Keep indexes as IndexDefinition objects for DDL strategies
    schema = {
      ddl: manifestEntry.schema.ddl,
      indexes:
        manifestEntry.schema.indexes?.map((idx: any) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: manifestEntry.schema.tableName || tableName,
      // Cast manifest columns to ColumnDefinition (same shape, TypeScript just needs help)
      columns: cloneManifestSchemaColumns(manifestEntry.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: manifestEntry.schema.version || '',
      packageName: manifestEntry.packageName,
    };
    verboseLog(
      `[registry] Loaded pre-generated schema for ${name} (${Object.keys(manifestEntry.schema.columns || {}).length} columns)`,
    );
  } else {
    // Placeholder schema - will be generated lazily when first needed
    schema = {
      ddl: '', // Generated lazily
      indexes: [], // Parsed from DDL lazily
      triggers: [], // No longer using database triggers - timestamps managed by application
      tableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: undefined,
    };
  }

  if (schema.columns && decorators && decorators.size > 0) {
    applySqlTypeOverrides(schema.columns, decorators.entries());
  }

  // Use pre-computed validation rules from manifest if available (Issue #782)
  // For decorator-based registration, manifest may have pre-computed rules
  const validationRules = manifestEntry?.validationRules;
  let validators: ValidatorFunction[] | undefined;

  // Only compile validators if no pre-computed rules exist
  if (!validationRules || validationRules.length === 0) {
    validators = compileValidators(name, fields);
  } else {
    verboseLog(
      `[registry] Using ${validationRules.length} pre-computed validation rules for ${name}`,
    );
  }

  // Derive extends from prototype chain if not available from manifest
  // This is critical for inline test classes that use decorators
  let extendsClass: string | undefined = manifestEntry?.extends;
  if (!extendsClass) {
    const proto = Object.getPrototypeOf(ctor);
    if (proto?.name && proto.name !== 'SmrtObject' && proto.name !== 'Object') {
      extendsClass = proto.name;
    }
  }

  // Merge manifest's decoratorConfig into config
  // Use the computed tableName which prioritizes manifest's value for STI correctness
  const mergedConfig = {
    ...manifestEntry?.decoratorConfig,
    ...config,
    tableName, // Override with correctly computed tableName
  };

  // Generate qualified name if we have a package name
  // Format: "@package/name:ClassName"
  const qualifiedName = packageName
    ? createQualifiedName(packageName, name)
    : undefined;

  // Determine visibility from config, manifest, or default to 'public'
  // Priority: explicit config > manifest > default
  const visibility: SmrtVisibility =
    config.visibility || manifestEntry?.visibility || 'public';

  // Issue #951: Use qualified name as primary key when available
  const registrationKey = qualifiedName || name;

  getClasses().set(registrationKey, {
    name,
    qualifiedName, // Qualified name for cross-package identification
    constructor: ctor,
    config: mergedConfig,
    fields,
    methods,
    schema,
    validators,
    validationRules, // Pre-computed rules from manifest (Issue #782)
    packageName, // Store package name from manifest for getPackageName() lookup
    sourceFilePath, // Store source file for collision detection (Issue #555)
    extends: extendsClass, // Capture parent class name from manifest OR prototype chain
    tenantScopedConfig, // Multi-tenancy config (Issue #688)
    visibility, // Visibility control for manifest filtering
    // NOTE: Don't pre-compute inheritanceChain here - let getInheritanceChain() compute
    // it lazily using the `extends` field. This ensures correct chain for both
    // decorator-registered and manifest-loaded classes.
  });

  // Release B (#1133): case-insensitive lookups iterate the classes Map
  // directly instead of maintaining a parallel classNameMap index.

  // Index constructor for O(1) reverse lookups (Issue #713: constructor-based lookup)
  getConstructorIndex().set(ctor, registrationKey);
  // Stamp the qualified name on the constructor itself as a fallback for
  // runtime code that has a constructor reference but might hit a
  // WeakMap miss (HMR / federated modules / multiple-copy edge cases).
  setSmrtQualifiedName(ctor, qualifiedName);

  verboseLog(
    `🎯 Registered smrt object: ${name} (key: ${registrationKey}) with schema for ${schema.tableName} and ${(validators?.length || 0) + (validationRules?.length || 0)} validators/rules`,
  );

  // STI sibling auto-loading (Issue #430)
  // When a class is registered that shares a table with other classes (STI),
  // we need to discover and register ALL siblings so that getAllSchemas()
  // can merge columns from all subtypes for the database adapter.
  //
  // IMPORTANT: Only auto-load siblings from EXTERNAL packages.
  // For test classes or classes in the same package, they will be registered
  // by their own @smrt() decorators. Auto-loading them as stubs would cause collisions.
  const collection = manifestEntry?.collection;
  if (collection && !getStiSiblingsLoaded().has(collection)) {
    // Mark this collection as processed to prevent infinite recursion
    getStiSiblingsLoaded().add(collection);

    verboseLog(
      `[registry] Checking for STI siblings for collection: ${collection}`,
    );

    // Discover all classes that share this collection (table)
    const siblings = discoverSTISiblingsSync(collection);

    // Register any siblings that aren't already registered
    // Only load siblings from DIFFERENT packages to avoid collisions with local classes
    for (const sibling of siblings) {
      // Use case-insensitive check to prevent registering 'Praeco' when 'praeco' exists
      if (!hasClassCaseInsensitive(sibling.className)) {
        // Skip siblings from the same package - they will be registered by their own decorators
        if (
          sibling.packageName &&
          packageName &&
          sibling.packageName === packageName
        ) {
          verboseLog(
            `[registry] Skipping STI sibling ${sibling.className} from same package: ${packageName}`,
          );
          continue;
        }

        verboseLog(
          `[registry] Auto-loading STI sibling: ${sibling.className} for collection: ${collection}`,
        );
        registerFromManifest(
          sibling.className,
          sibling.entry,
          sibling.packageName,
        );
      }
    }
  }
}

export function registerCollection(
  objectName: string,
  collectionConstructor: new (options: any) => SmrtCollection<any>,
): void {
  const registered = findClass(objectName);
  if (registered) {
    registered.collectionConstructor = collectionConstructor;
  }

  getCollections().set(objectName, collectionConstructor as any);
}

// resolveManifestCollision was removed in Release C (#1134). Its three-branch
// decision is now represented as explicit rows in the collision-policy
// decision table — see `manifest-same-source-file`, `manifest-sti-child-wins`,
// `manifest-sti-parent-skip`, `manifest-default-skip` scenarios in
// packages/core/src/registry/collision-policy.ts.

function normalizeTenantScopedConfig(
  tenantScoped: any,
): RegisteredClass['tenantScopedConfig'] | undefined {
  if (!tenantScoped) {
    return undefined;
  }

  const tenantOpts = typeof tenantScoped === 'boolean' ? {} : tenantScoped;
  return {
    mode: tenantOpts.mode ?? 'required',
    field: tenantOpts.field ?? 'tenantId',
    autoFilter: tenantOpts.autoFilter ?? true,
    autoPopulate: tenantOpts.autoPopulate ?? true,
    allowSuperAdminBypass: tenantOpts.allowSuperAdminBypass ?? false,
  };
}

function ensureTenantScopedField(
  fields: Map<string, any>,
  tenantScopedConfig: RegisteredClass['tenantScopedConfig'] | undefined,
): void {
  if (!tenantScopedConfig) {
    return;
  }

  const fieldName = tenantScopedConfig.field;
  if (fields.has(fieldName)) {
    return;
  }

  fields.set(fieldName, {
    type: 'foreignKey',
    related: 'Tenant',
    required: tenantScopedConfig.mode === 'required',
    _meta: {
      reference: 'Tenant',
      sqlType: 'TEXT',
      __tenancy: {
        isTenantIdField: true,
        ...tenantScopedConfig,
      },
    },
  });
}

function mergeIndexDefinitions(
  existingIndexes: Array<any> | undefined,
  manifestIndexes: Array<any> | undefined,
): Array<any> {
  const merged = [...(existingIndexes || [])];
  const seen = new Set(merged.map((index) => index?.name).filter(Boolean));

  for (const index of manifestIndexes || []) {
    if (!index?.name || seen.has(index.name)) {
      continue;
    }
    merged.push(index);
    seen.add(index.name);
  }

  return merged;
}

// cloneManifestSchemaColumns lives in ../manifest/store.ts — imported above.
// (Hoisted out of the duplicate definition here and in registry.ts.)

function applySqlTypeOverrides(
  columns: Record<string, ColumnDefinition>,
  fieldEntries: Iterable<[string, any]> | undefined,
): void {
  if (!fieldEntries) {
    return;
  }

  for (const [fieldName, fieldOptions] of fieldEntries) {
    const sqlType = fieldOptions?.sqlType ?? fieldOptions?._meta?.sqlType;
    if (!sqlType) {
      continue;
    }

    const columnName = toSnakeCase(fieldName);
    const existingColumn = columns[columnName];
    if (!existingColumn) {
      continue;
    }

    columns[columnName] = {
      ...existingColumn,
      type: sqlType,
    };
  }
}

/**
 * Invalidate cached inheritance state (chain + inheritedFields +
 * inheritedMethods) on `existing` AND every descendant whose `extends` or
 * `inheritanceChain` references it.
 *
 * This covers both simple-name and qualified-name `extends` matches, which
 * is why `ObjectRegistry.invalidateInheritanceCache` delegates here (Release
 * C follow-up #1139 Gap 1 — the old recursive public helper only matched
 * `extends === className` by exact string, silently missing qualified
 * descendants like `@pkg:Parent`).
 *
 * `previousIdentity` is used by `upsertExistingEntry` (Gap 2): when a class
 * is promoted (its name/packageName/qualifiedName are mutated in place),
 * descendants registered against the pre-mutation identity need to be
 * invalidated too. Pass the pre-mutation `{ name, qualifiedName }` so this
 * sweep matches against both the old and new identity.
 *
 * Exported for the public `ObjectRegistry.invalidateInheritanceCache`
 * shim in registry.ts.
 */
export function invalidateInheritanceEntries(
  existing: RegisteredClass,
  previousIdentity?: {
    name?: string;
    qualifiedName?: string;
  },
): void {
  const cache = getInheritanceCache();
  const affectedNames = new Set<string>();

  const remember = (name: string | undefined): void => {
    if (name) {
      affectedNames.add(name);
    }
  };

  const matchNames = new Set<string>();
  const rememberMatch = (name: string | undefined): void => {
    if (name) matchNames.add(name);
  };
  rememberMatch(existing.name);
  rememberMatch(existing.qualifiedName);
  rememberMatch(previousIdentity?.name);
  rememberMatch(previousIdentity?.qualifiedName);

  for (const name of matchNames) {
    remember(name);
  }

  for (const [key, candidate] of getClasses()) {
    const extendsMatches =
      !!candidate.extends && matchNames.has(candidate.extends);
    const chainMatches =
      !!candidate.inheritanceChain &&
      candidate.inheritanceChain.some((n) => matchNames.has(n));

    if (candidate === existing || extendsMatches || chainMatches) {
      candidate.inheritanceChain = undefined;
      candidate.inheritedFields = undefined;
      candidate.inheritedMethods = undefined;
      remember(key);
      remember(candidate.name);
      remember(candidate.qualifiedName);
    }
  }

  for (const name of affectedNames) {
    cache.delete(name);
  }
}

function mergeManifestIntoExistingRegistration(
  existing: RegisteredClass,
  objectDef: any,
  packageName?: string,
): void {
  const manifestConfig = objectDef.decoratorConfig || {};
  const manifestTableName =
    objectDef.schema?.tableName ||
    manifestConfig.tableName ||
    existing.schema?.tableName ||
    existing.config.tableName ||
    tableNameFromClass(existing.constructor);

  existing.config = {
    ...manifestConfig,
    ...existing.config,
    tableName: manifestTableName,
  };

  if (objectDef.fields) {
    for (const [fieldName, fieldDef] of Object.entries(
      objectDef.fields as Record<string, any>,
    )) {
      const fd = fieldDef as any;
      if (!existing.fields.has(fieldName)) {
        existing.fields.set(fieldName, createFieldFromManifest(fd));
        continue;
      }

      const existingField = existing.fields.get(fieldName);
      if (!existingField) {
        continue;
      }

      existing.fields.set(fieldName, mergeManifestField(existingField, fd));
    }
  }

  const tenantScopedConfig = normalizeTenantScopedConfig(
    existing.config.tenantScoped,
  );
  if (tenantScopedConfig) {
    existing.tenantScopedConfig = tenantScopedConfig;
    ensureTenantScopedField(existing.fields, tenantScopedConfig);
  }

  if (objectDef.methods) {
    for (const [methodName, methodDef] of Object.entries(
      objectDef.methods as Record<string, any>,
    )) {
      existing.methods.set(methodName, methodDef);
    }
  }

  if (objectDef.schema) {
    const manifestSchema: SchemaDefinition = {
      ddl: objectDef.schema.ddl || '',
      indexes:
        objectDef.schema.indexes?.map((idx: any) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: objectDef.schema.tableName || manifestTableName,
      columns: cloneManifestSchemaColumns(objectDef.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: objectDef.schema.version || '',
      packageName: packageName,
    };

    applySqlTypeOverrides(manifestSchema.columns, existing.fields.entries());

    existing.schema = {
      ...(existing.schema || {}),
      ...manifestSchema,
      tableName: manifestSchema.tableName,
      ddl: manifestSchema.ddl || existing.schema?.ddl || '',
      columns: {
        ...(existing.schema?.columns || {}),
        ...(manifestSchema.columns || {}),
      },
      indexes: mergeIndexDefinitions(
        existing.schema?.indexes,
        manifestSchema.indexes,
      ),
      packageName: packageName || existing.schema?.packageName,
    };
  } else if (!existing.schema) {
    existing.schema = {
      ddl: '',
      indexes: [],
      triggers: [],
      tableName: manifestTableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: packageName,
    };
  } else {
    existing.schema.tableName = manifestTableName;
    existing.schema.packageName = packageName || existing.schema.packageName;
  }

  if (objectDef.validationRules !== undefined) {
    existing.validationRules = objectDef.validationRules;
    existing.validators = undefined;
  } else if (!existing.validationRules && !existing.validators) {
    existing.validators = compileValidators(existing.name, existing.fields);
  }

  if (packageName) {
    existing.packageName = packageName;
    existing.qualifiedName = createQualifiedName(
      packageName,
      existing.name,
    ) as QualifiedClassName;
  } else if (!existing.packageName && objectDef.packageName) {
    existing.packageName = objectDef.packageName;
  }

  if (objectDef.extends) {
    existing.extends = packageName
      ? qualifyExtendsName(objectDef.extends, packageName)
      : objectDef.extends;
  }

  if (!existing.sourceFilePath && objectDef.filePath) {
    existing.sourceFilePath = objectDef.filePath;
  }

  existing.visibility =
    objectDef.visibility || manifestConfig.visibility || existing.visibility;
  invalidateInheritanceEntries(existing);
}

export function registerFromManifest(
  name: string,
  objectDef: any,
  packageName?: string,
): void {
  // Issue #951: Compute simple class name and registration key early
  // `name` may be a qualified key from manifest (e.g., '@happyvertical/smrt-events:Event')
  // `simpleClassName` is always the plain class name (e.g., 'Event')
  const simpleClassName = objectDef.className || name;
  const qualifiedNameEarly = packageName
    ? createQualifiedName(packageName, simpleClassName)
    : (objectDef.qualifiedName as QualifiedClassName | undefined);
  const registrationKey = (qualifiedNameEarly || name) as string;

  // Release C (#1134): collision resolution routes through
  // decideCollisionPolicy. See collision-policy.ts for the 16-row decision
  // table; applyManifestCollisionPolicy below turns a policy into registry
  // mutations.
  //
  // Two collision checks, matching pre-C behavior:
  //   1. Canonical-name lookup (case-insensitive simple-name match; covers
  //      issue #950's STI child-wins and issue #951's qualified coexistence).
  //   2. Exact-key match (handles re-registration with same qualified key).
  //
  // The ambiguous case (multiple existing entries share the simple name —
  // `getCanonicalClassName` returns undefined) is NOT fed through the table.
  // It falls through both checks into the new-registration code below,
  // preserving issue #951's coexistence semantics.
  const existingCanonical = getCanonicalClassName(simpleClassName);
  if (existingCanonical) {
    const existing = getClasses().get(existingCanonical);
    if (existing) {
      const outcome = applyManifestCollisionPolicy({
        name,
        objectDef,
        packageName,
        existing,
        existingKey: existingCanonical,
        registrationKey,
        matchKind: 'canonical-name',
      });
      if (outcome === 'return') return;
      // outcome === 'continue' means policy was replace (child-wins) or
      // coexist — fall through into the new-registration code below.
    }
    // else: stale map entry (key exists but class was removed) — allow registration
  }

  if (getClasses().has(registrationKey)) {
    const existing = getClasses().get(registrationKey);
    if (!existing) return;
    const outcome = applyManifestCollisionPolicy({
      name,
      objectDef,
      packageName,
      existing,
      existingKey: registrationKey,
      registrationKey,
      matchKind: 'exact-key',
    });
    if (outcome === 'return') return;
  }

  // Issue #1004: Qualify the `extends` value BEFORE inserting this class
  // into the classes Map. Otherwise qualifyExtendsName would iterate and
  // find the child's own entry, creating a circular extends chain
  // (e.g., @test/sports:TestEvent extends itself). Release B (#1133) swapped
  // the underlying classNameMap lookup for an iteration over `classes`, but
  // the ordering invariant still holds.
  const qualifiedExtends =
    objectDef.extends && packageName
      ? qualifyExtendsName(objectDef.extends, packageName)
      : objectDef.extends;

  // Release B (#1133): case-insensitive lookups iterate the classes Map
  // directly; no parallel classNameMap index to maintain.

  // Create stub constructor - not needed for CLI command generation
  // The CLI only needs metadata (fields, methods, config)
  // Mark as manifest stub so real class can replace it during decorator registration
  const stubConstructor = class extends SmrtObject {
    static readonly _isManifestStub = true;
  } as typeof SmrtObject;
  Object.defineProperty(stubConstructor, 'name', { value: simpleClassName });

  // Convert manifest field definitions to Field objects
  const fields = new Map<string, any>();
  const decorators = getFieldDecorators().get(simpleClassName);
  if (objectDef.fields) {
    for (const [fieldName, fieldDef] of Object.entries(
      objectDef.fields as any,
    )) {
      const fd = fieldDef as any;
      fields.set(fieldName, createFieldFromManifest(fd));
    }
  }

  // Load method definitions
  const methods = new Map<string, any>();
  if (objectDef.methods) {
    for (const [methodName, methodDef] of Object.entries(objectDef.methods)) {
      methods.set(methodName, methodDef);
    }
  }

  // Get config from manifest
  const config = objectDef.decoratorConfig || {};
  const tableName = config.tableName || tableNameFromClass(stubConstructor);

  // Load pre-generated schema from manifest if available
  // This enables efficient external package consumption without runtime schema generation
  let schema: SchemaDefinition;
  if (objectDef.schema) {
    // Pre-generated schema from manifest (build-time)
    // Keep indexes as IndexDefinition objects for DDL strategies
    schema = {
      ddl: objectDef.schema.ddl,
      indexes:
        objectDef.schema.indexes?.map((idx: any) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: objectDef.schema.tableName,
      columns: cloneManifestSchemaColumns(objectDef.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: objectDef.schema.version || '',
      packageName: packageName,
    };
    applySqlTypeOverrides(schema.columns, decorators?.entries());
    verboseLog(
      `[registry] Loaded pre-generated schema for ${name} (${Object.keys(objectDef.schema.columns || {}).length} columns)`,
    );
  } else {
    // Placeholder schema - will be generated at runtime if needed
    schema = {
      ddl: '',
      indexes: [],
      triggers: [],
      tableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: packageName,
    };
  }

  // Use pre-computed validation rules from manifest if available (Issue #782)
  // This avoids compiling validator closures at runtime, reducing startup time
  const validationRules = objectDef.validationRules;
  let validators: ValidatorFunction[] | undefined;

  // Only compile validators if no pre-computed rules exist
  // (backward compatibility for older manifests)
  if (!validationRules || validationRules.length === 0) {
    validators = compileValidators(name, fields);
    verboseLog(
      `[registry] No pre-computed rules for ${name}, compiled ${validators.length} validators`,
    );
  } else {
    verboseLog(
      `[registry] Using ${validationRules.length} pre-computed validation rules for ${name}`,
    );
  }

  // Issue #951: Use qualifiedNameEarly computed at the top of this function
  // (uses simpleClassName, not the manifest key which may already be qualified)
  const qualifiedName = qualifiedNameEarly;

  // Get visibility from manifest (defaults to 'public')
  const visibility: SmrtVisibility =
    objectDef.visibility || config.visibility || 'public';

  // Register in ObjectRegistry (metadata only, no collection constructor)
  // Manifest registration is for command discovery and help text.
  // Runtime execution requires real classes loaded from entry point.
  //
  // Issue #847: Use className from objectDef (simple name like 'Council') for the name
  // property, not the qualified name key. This enables getFields() lookups by simple
  // class name to work correctly. simpleClassName is defined earlier in this function.
  //
  // Issue #951: Use registrationKey (qualified when available) as the primary key
  getClasses().set(registrationKey, {
    name: simpleClassName,
    qualifiedName, // Qualified name for cross-package identification
    constructor: stubConstructor,
    config,
    fields,
    methods,
    schema,
    validators,
    validationRules, // Pre-computed rules from manifest (Issue #782)
    packageName,
    sourceFilePath: objectDef.filePath, // Store source file for collision detection (Issue #555)
    extends: qualifiedExtends, // Issue #1004: Pre-computed qualified parent
    visibility, // New: Visibility control for manifest filtering
  });
  // Tag the synthetic stub constructor with the qualified name so the
  // same constructor-side identity convention holds for manifest-loaded
  // classes as well as decorator-registered ones.
  setSmrtQualifiedName(stubConstructor, qualifiedName);

  verboseLog(
    `📦 Registered ${simpleClassName} from manifest (key: ${registrationKey}, ${fields.size} fields, ${methods.size} methods)`,
  );

  // STI sibling auto-loading (Issue #430)
  // When a class is registered that shares a table with other classes (STI),
  // we need to discover and register ALL siblings so that getAllSchemas()
  // can merge columns from all subtypes for the database adapter.
  //
  // IMPORTANT: Only auto-load siblings from EXTERNAL packages.
  // For test classes or classes in the same package, they will be registered
  // by their own @smrt() decorators. Auto-loading them as stubs would cause collisions.
  const collection = objectDef.collection;
  if (collection && !getStiSiblingsLoaded().has(collection)) {
    // Mark this collection as processed to prevent infinite recursion
    getStiSiblingsLoaded().add(collection);

    verboseLog(
      `[registry] Checking for STI siblings for collection: ${collection}`,
    );

    // Discover all classes that share this collection (table)
    const siblings = discoverSTISiblingsSync(collection);

    // Register any siblings that aren't already registered
    // Only load siblings from DIFFERENT packages to avoid collisions with local classes
    for (const sibling of siblings) {
      // Use case-insensitive check to prevent registering 'Praeco' when 'praeco' exists
      if (!hasClassCaseInsensitive(sibling.className)) {
        // Skip siblings from the same package - they will be registered by their own decorators
        if (
          sibling.packageName &&
          packageName &&
          sibling.packageName === packageName
        ) {
          verboseLog(
            `[registry] Skipping STI sibling ${sibling.className} from same package: ${packageName}`,
          );
          continue;
        }

        verboseLog(
          `[registry] Auto-loading STI sibling: ${sibling.className} for collection: ${collection}`,
        );
        registerFromManifest(
          sibling.className,
          sibling.entry,
          sibling.packageName,
        );
      }
    }
  }
}
