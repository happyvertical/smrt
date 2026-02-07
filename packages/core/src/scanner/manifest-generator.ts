/**
 * Manifest generator for creating service manifests from AST scan results
 */

import { createRequire } from 'node:module';
import {
  loadExternalManifestSync,
  lookupInManifest,
} from '../manifest/manifest-loader.js';
import { generateToolManifest } from '../tools/tool-generator';
import { createQualifiedName } from '../utils/qualified-names.js';
import { classnameToTablename } from '../utils.js';
import { isTestFile } from './test-file-patterns.js';
import type {
  AgentAdminRouteManifest,
  AgentComponentDeclaration,
  AgentFeature,
  AgentManifest,
  AgentMenuItem,
  AgentPermission,
  AgentUISlotManifest,
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
  SmrtVisibility,
  ValidationRule,
} from './types';

// Create require function for synchronous module loading in ESM context
const require = createRequire(import.meta.url);

/**
 * Infer visibility from file path and explicit config
 *
 * Priority:
 * 1. Explicit visibility in decorator config
 * 2. Auto-detect test files → 'test'
 * 3. Default to 'public'
 */
function inferVisibility(
  filePath: string,
  explicitVisibility?: SmrtVisibility,
): SmrtVisibility {
  if (explicitVisibility) return explicitVisibility;
  if (isTestFile(filePath)) return 'test';
  return 'public';
}

export class ManifestGenerator {
  /**
   * Generate manifest from scan results
   *
   * @param scanResults - Array of scan results containing object definitions
   * @param options - Optional configuration
   * @param options.packageName - Package name to inject into manifest and object definitions
   * @param options.packageVersion - Package version
   * @param options.packageJson - Full package.json object for determining import paths
   * @param options.smrtDependencies - List of SMRT package dependencies to include in manifest
   * @param options.includeVisibility - Array of visibility levels to include (default: all)
   *   - For published packages: ['public']
   *   - For development: ['public', 'internal', 'test'] or omit for all
   */
  generateManifest(
    scanResults: ScanResult[],
    options?: {
      packageName?: string;
      packageVersion?: string;
      packageJson?: any;
      smrtDependencies?: string[];
      includeVisibility?: SmrtVisibility[];
    },
  ): SmartObjectManifest {
    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {},
    };

    // Set package metadata at manifest level if provided
    if (options?.packageName) {
      manifest.packageName = options.packageName;
    }
    if (options?.packageVersion) {
      manifest.packageVersion = options.packageVersion;
    }
    // Set smrtDependencies BEFORE mergeInheritedFields() so external packages can be loaded
    if (options?.smrtDependencies) {
      manifest.smrtDependencies = options.smrtDependencies;
    }

    for (const result of scanResults) {
      for (const objectDef of result.objects) {
        // Set package metadata on object definition if provided
        if (options?.packageName) {
          objectDef.packageName = options.packageName;
        }
        if (options?.packageVersion) {
          objectDef.packageVersion = options.packageVersion;
        }

        // Generate qualified name (required for manifest keying)
        // Must have packageName to generate qualified name
        if (objectDef.packageName) {
          objectDef.qualifiedName = createQualifiedName(
            objectDef.packageName,
            objectDef.className,
          );
        }

        // Infer visibility from file path and decorator config
        objectDef.visibility = inferVisibility(
          objectDef.filePath,
          objectDef.decoratorConfig?.visibility as SmrtVisibility | undefined,
        );

        // Filter by visibility if specified
        // Skip objects that don't match the requested visibility levels
        if (
          options?.includeVisibility &&
          options.includeVisibility.length > 0 &&
          !options.includeVisibility.includes(objectDef.visibility)
        ) {
          // Skip this object - visibility not in allowed list
          continue;
        }

        // Determine import path from package.json exports
        if (options?.packageName && options?.packageJson) {
          objectDef.importPath = this.determineImportPath(
            options.packageJson,
            objectDef.filePath,
          );
        }

        // Set export names (defaults to className)
        objectDef.exportName = objectDef.exportName || objectDef.className;
        objectDef.collectionExportName =
          objectDef.collectionExportName || `${objectDef.className}Collection`;

        // Inject tenantId field if tenantScoped is configured (Issue #812)
        if (objectDef.decoratorConfig.tenantScoped) {
          const tenantConfig =
            typeof objectDef.decoratorConfig.tenantScoped === 'boolean'
              ? {}
              : objectDef.decoratorConfig.tenantScoped;

          const fieldName = tenantConfig.field || 'tenantId';
          const isRequired = tenantConfig.mode === 'required';

          // Inject tenantId field definition into manifest
          objectDef.fields[fieldName] = {
            type: 'text',
            required: isRequired,
            _meta: {
              generated: true,
              source: 'tenantScoped_decorator',
              ...tenantConfig,
            },
          };

          console.log(
            `[manifest-generator] Injected ${fieldName} field for ${objectDef.className} (tenantScoped: ${JSON.stringify(tenantConfig)})`,
          );
        }

        // Generate AI tools from methods if AI config exists
        if (objectDef.decoratorConfig.ai) {
          const methods = Object.values(objectDef.methods);
          const tools = generateToolManifest(
            methods,
            objectDef.decoratorConfig.ai,
          );

          // Store tools in object definition
          if (tools.length > 0) {
            objectDef.tools = tools;
          }
        }

        // Determine manifest key: use qualified name if available, fall back to lowercase name
        // During transition, some objects may not have qualified names
        const manifestKey = objectDef.qualifiedName || objectDef.name;

        // Check for collisions using the manifest key
        if (manifest.objects[manifestKey]) {
          const existing = manifest.objects[manifestKey];
          throw new Error(
            `Class name collision detected: '${objectDef.className}' (${manifestKey}) is defined in multiple files:\n` +
              `  1. ${existing.filePath}\n` +
              `  2. ${objectDef.filePath}\n\n` +
              `Class names must be unique within a package. Use different class names or separate packages.`,
          );
        }

        manifest.objects[manifestKey] = objectDef;
      }
    }

    // Second pass: Merge inherited fields for STI classes
    // This ensures STI subclasses have all parent fields inline in the manifest
    this.mergeInheritedFields(manifest);

    // Third pass: Generate validation rules for all objects
    // This pre-computes validation rules from field definitions, eliminating
    // the need to compile validator closures at runtime (Issue #782)
    this.generateValidationRules(manifest);

    // Fourth pass: Generate schemas for each object (build-time schema generation)
    // This pre-computes DDL, indexes, and columns for efficient external package consumption
    this.generateSchemas(manifest);

    // Fifth pass: Generate agent manifests for Agent subclasses
    // Derives permissions, features, menuItems, and components from code
    this.generateAgentManifests(
      manifest,
      options?.packageName,
      options?.packageJson,
    );

    return manifest;
  }

  /**
   * Generate pre-computed validation rules for all objects in the manifest.
   *
   * This extracts validation constraints (required, min, max, minLength, maxLength, pattern)
   * from field definitions and stores them as serializable rules in the manifest.
   *
   * At runtime, these rules can be evaluated without creating validator closures,
   * significantly reducing CLI startup time for projects with many SMRT objects.
   *
   * @param manifest - The manifest to process in-place
   */
  generateValidationRules(manifest: SmartObjectManifest): void {
    for (const [name, obj] of Object.entries(manifest.objects)) {
      const rules: ValidationRule[] = [];

      for (const [fieldName, field] of Object.entries(obj.fields)) {
        // Skip transient fields (they're not persisted, so no validation needed)
        if (field.transient || field._meta?.transient) {
          continue;
        }

        const options = field._meta || {};

        // Required field rule
        if (options.required || field.required) {
          rules.push({
            field: fieldName,
            rule: 'required',
            fieldType: field.type,
          });
        }

        // Numeric range rules (for integer, decimal fields)
        if (field.type === 'integer' || field.type === 'decimal') {
          if (options.min !== undefined || field.min !== undefined) {
            rules.push({
              field: fieldName,
              rule: 'min',
              value: options.min ?? field.min,
              fieldType: field.type,
            });
          }

          if (options.max !== undefined || field.max !== undefined) {
            rules.push({
              field: fieldName,
              rule: 'max',
              value: options.max ?? field.max,
              fieldType: field.type,
            });
          }
        }

        // String length rules (for text fields)
        if (field.type === 'text') {
          if (
            options.minLength !== undefined ||
            field.minLength !== undefined
          ) {
            rules.push({
              field: fieldName,
              rule: 'minLength',
              value: options.minLength ?? field.minLength,
              fieldType: field.type,
            });
          }

          if (
            options.maxLength !== undefined ||
            field.maxLength !== undefined
          ) {
            rules.push({
              field: fieldName,
              rule: 'maxLength',
              value: options.maxLength ?? field.maxLength,
              fieldType: field.type,
            });
          }

          // Pattern rule (regex validation)
          // Note: Custom validator functions (options.validate) cannot be serialized
          // and will fall back to compiled validators at runtime
          // Note: Pattern is only available in field options, not in FieldDefinition
          const pattern = options.pattern;
          if (pattern) {
            rules.push({
              field: fieldName,
              rule: 'pattern',
              value: typeof pattern === 'string' ? pattern : pattern.source,
              fieldType: field.type,
            });
          }
        }
      }

      // Only add validationRules if there are any rules
      if (rules.length > 0) {
        obj.validationRules = rules;
      }
    }
  }

  /**
   * Generate pre-computed schemas for all objects in the manifest.
   *
   * This enables external package consumers to use pre-generated schemas
   * without calling generateSchema() at runtime, eliminating latency.
   *
   * IMPORTANT: For STI classes, we aggregate ALL descendants from both local
   * and external packages to ensure complete schemas are generated.
   *
   * This method is public to allow external callers (like OXC scanner) to use it.
   *
   * @param manifest - The manifest to process in-place
   */
  generateSchemas(manifest: SmartObjectManifest): void {
    // Import SchemaGenerator synchronously (using createRequire for ESM compatibility)
    // Try .js first (built output), fall back to .ts (source for tests)
    let SchemaGenerator: any;
    try {
      SchemaGenerator = require('../schema/generator.js').SchemaGenerator;
    } catch {
      // Fallback for when running tests directly on source files
      SchemaGenerator = require('../schema/generator.ts').SchemaGenerator;
    }
    const generator = new SchemaGenerator();

    // Create aggregated manifest that includes external package objects
    // This ensures STI schema generation finds ALL descendants
    const aggregatedManifest = this.createAggregatedManifest(manifest);

    // Track which STI bases have been processed (to avoid duplicate schema generation)
    const processedSTIBases = new Set<string>();

    // Build lookup map for checking if base is local
    const localObjects = new Set(
      Object.values(manifest.objects).map((o) => o.className),
    );

    for (const [name, obj] of Object.entries(manifest.objects)) {
      // Determine table name (may have been inherited from external STI base)
      // Use obj.className (PascalCase) for consistent table name derivation with runtime
      const tableName =
        obj.decoratorConfig?.tableName ||
        this.classNameToTableName(obj.className);

      // Check if this is an STI class
      if (obj.decoratorConfig?.tableStrategy === 'sti') {
        // This is an STI base class - generate STI schema with ALL descendants
        if (processedSTIBases.has(name)) continue;
        processedSTIBases.add(name);

        console.log(
          `[manifest-generator] Generating STI schema for ${name} (table: ${tableName})`,
        );

        // Use aggregated manifest to find descendants from ALL packages
        obj.schema = generator.generateSTISchemaFromManifest(
          name,
          tableName,
          obj.fields,
          aggregatedManifest,
        );
      } else if (this.isSTIChildClass(obj, manifest)) {
        // This is an STI child class - check if base is LOCAL or EXTERNAL
        const stiBase = this.findSTIBaseInfo(obj, manifest);
        const baseIsLocal = stiBase && localObjects.has(stiBase.className);

        if (baseIsLocal) {
          // STI base is in this manifest - skip (schema is on base class)
          console.log(
            `[manifest-generator] Skipping schema for STI child ${name} (base ${stiBase?.className} is local)`,
          );
        } else {
          // STI base is EXTERNAL - generate STI schema for this child
          // CRITICAL: Use the external base's table name, not the child's!
          const baseTableName = stiBase?.tableName || tableName;
          console.log(
            `[manifest-generator] Generating STI schema for ${name} (external base: ${stiBase?.className}, table: ${baseTableName})`,
          );

          // Use aggregated manifest to include all descendants
          // FIX #527: Use actual STI base class name, not child class name
          // This ensures findDescendantsInManifest() finds ALL STI children
          obj.schema = generator.generateSTISchemaFromManifest(
            stiBase?.className || name,
            baseTableName,
            obj.fields,
            aggregatedManifest,
          );
        }
      } else {
        // CTI class - generate individual table schema
        console.log(
          `[manifest-generator] Generating CTI schema for ${name} (table: ${tableName})`,
        );

        obj.schema = generator.generateCTISchemaFromManifest(
          name,
          tableName,
          obj.fields,
          obj.decoratorConfig,
        );
      }
    }
  }

  /**
   * Create an aggregated manifest that includes objects from all external packages
   *
   * This is used for STI schema generation to ensure ALL descendants are found,
   * regardless of which package they're defined in.
   *
   * @param manifest - The local manifest
   * @returns Aggregated manifest with local + external objects
   */
  private createAggregatedManifest(
    manifest: SmartObjectManifest,
  ): SmartObjectManifest {
    // Start with a copy of local objects
    const aggregatedObjects: Record<string, SmartObjectDefinition> = {
      ...manifest.objects,
    };

    // Load and merge external package objects
    if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
      for (const packageName of manifest.smrtDependencies) {
        const externalManifest = loadExternalManifestSync(packageName);
        if (externalManifest) {
          // Merge external objects (local objects take precedence on collision)
          for (const [name, obj] of Object.entries(externalManifest.objects)) {
            if (!aggregatedObjects[name]) {
              aggregatedObjects[name] = obj;
            }
          }

          console.log(
            `[manifest-generator] Aggregated ${Object.keys(externalManifest.objects).length} objects from ${packageName}`,
          );
        }
      }
    }

    return {
      ...manifest,
      objects: aggregatedObjects,
    };
  }

  /**
   * Check if an object is an STI child class (inherits from STI base)
   *
   * Walks up the inheritance chain to find if any ancestor has tableStrategy: 'sti'.
   * Also checks external SMRT packages for parent class definitions.
   */
  private isSTIChildClass(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): boolean {
    if (!obj.extends) return false;

    // Build a lookup map for efficient access
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [_name, objDef] of Object.entries(manifest.objects)) {
      objectsByName.set(objDef.className, objDef);
      objectsByName.set(objDef.className.toLowerCase(), objDef);
    }

    // Walk up the inheritance chain looking for STI base
    let currentClass: string | undefined = obj.extends;
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) break;
      visited.add(currentClass);

      let parentObj = objectsByName.get(currentClass);

      // If parent not in current manifest, try loading from external SMRT packages
      if (
        !parentObj &&
        manifest.smrtDependencies &&
        manifest.smrtDependencies.length > 0
      ) {
        parentObj = this.loadParentFromExternalPackage(
          currentClass,
          manifest.smrtDependencies,
          objectsByName,
        );
      }

      if (!parentObj) break; // Parent not found anywhere (e.g., SmrtObject)

      if (parentObj.decoratorConfig?.tableStrategy === 'sti') {
        return true; // Found STI ancestor
      }

      currentClass = parentObj.extends;
    }

    return false;
  }

  /**
   * Find full STI base class info (className + tableName)
   *
   * Walks up the inheritance chain to find the STI base class and returns
   * both its className and tableName. This is critical for external STI bases
   * where the child needs to use the base's table name for schema generation.
   */
  private findSTIBaseInfo(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): { className: string; tableName: string } | undefined {
    if (!obj.extends) return undefined;

    // Build a lookup map for efficient access
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [_name, objDef] of Object.entries(manifest.objects)) {
      objectsByName.set(objDef.className, objDef);
      objectsByName.set(objDef.className.toLowerCase(), objDef);
    }

    // Track the oldest STI base found as we walk up
    // (we need to keep walking to find the ROOT STI class, not the first one)
    let stiBaseInfo: { className: string; tableName: string } | undefined;

    // Walk up the inheritance chain looking for the OLDEST STI base
    let currentClass: string | undefined = obj.extends;
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) break;
      visited.add(currentClass);

      let parentObj = objectsByName.get(currentClass);

      // If parent not in current manifest, try loading from external SMRT packages
      if (
        !parentObj &&
        manifest.smrtDependencies &&
        manifest.smrtDependencies.length > 0
      ) {
        parentObj = this.loadParentFromExternalPackage(
          currentClass,
          manifest.smrtDependencies,
          objectsByName,
        );
      }

      if (!parentObj) break;

      if (parentObj.decoratorConfig?.tableStrategy === 'sti') {
        // Found an STI ancestor - it becomes the new candidate base
        // Keep walking to find the OLDEST/ROOT STI class in the hierarchy
        const tableName =
          parentObj.decoratorConfig?.tableName ||
          parentObj.schema?.tableName ||
          this.classNameToTableName(parentObj.className);
        stiBaseInfo = {
          className: parentObj.className,
          tableName,
        };
      }

      currentClass = parentObj.extends;
    }

    return stiBaseInfo; // Return the oldest STI ancestor found (or undefined if none)
  }

  /**
   * Convert class name to table name (snake_case pluralized)
   *
   * IMPORTANT: Must use the same algorithm as runtime's tableNameFromClass()
   * to ensure manifest-generated table names match runtime-derived names.
   */
  private classNameToTableName(className: string): string {
    // Use the shared pluralization function that handles English plurals correctly
    // (e.g., 'Currency' → 'currencies', 'JournalEntry' → 'journal_entries')
    return classnameToTablename(className);
  }

  /**
   * Merge inherited fields into child classes (build-time inheritance resolution)
   *
   * For STI hierarchies, child classes don't define their own fields in source code
   * (they inherit from parent). This method merges parent fields into child manifests
   * so that runtime code doesn't need to do field resolution.
   *
   * Also handles collection classes (SmrtCollection<T>) that should inherit their
   * item class's tableName and collection when the item uses STI.
   *
   * Handles multi-level inheritance (grandparents, great-grandparents, etc.)
   * Automatically loads parent class definitions from external SMRT packages when needed
   *
   * @param manifest - The manifest to process in-place
   */
  public mergeInheritedFields(manifest: SmartObjectManifest): void {
    // Build a map of className -> objectDef for fast lookup
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [name, obj] of Object.entries(manifest.objects)) {
      objectsByName.set(obj.className, obj);
      // Also store by lowercase name for case-insensitive lookup
      objectsByName.set(obj.className.toLowerCase(), obj);
    }

    // FIRST PASS: Handle STI field merging and tableName inheritance
    // This must happen FIRST so that item classes (like Meeting) have their tableName
    // inherited from their STI base (like Event) before collection classes (like Meetings)
    // try to read it
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.extends) continue; // No parent, skip

      // Only merge if using STI (shared table with parent)
      // For CTI (class table inheritance), each class has its own table and fields
      // Check if this class or ANY ancestor uses STI (inherited strategy)
      const usesSTI = this.isSTIClass(obj, objectsByName, manifest);

      if (!usesSTI) {
        continue; // CTI - no field merging needed
      }

      console.log(
        `[manifest-generator] Merging inherited fields for ${obj.className} from ${obj.extends}`,
      );

      // Build full inheritance chain (base -> child)
      const inheritanceChain: string[] = [];
      let currentClass: string | undefined = obj.extends;
      const visited = new Set<string>();

      while (currentClass) {
        if (visited.has(currentClass)) {
          console.warn(
            `[manifest-generator] Circular inheritance detected for ${obj.className}`,
          );
          break;
        }
        visited.add(currentClass);
        inheritanceChain.unshift(currentClass); // Add to front (building base -> child)

        let parentObj = objectsByName.get(currentClass);

        // If parent not in current manifest, try loading from external SMRT packages
        if (
          !parentObj &&
          manifest.smrtDependencies &&
          manifest.smrtDependencies.length > 0
        ) {
          parentObj = this.loadParentFromExternalPackage(
            currentClass,
            manifest.smrtDependencies,
            objectsByName,
          );
        }

        if (!parentObj) break; // Parent not found anywhere (e.g., SmrtObject)
        currentClass = parentObj.extends;
      }

      console.log(
        `[manifest-generator] Inheritance chain for ${obj.className}: ${inheritanceChain.join(' -> ')}`,
      );

      // Merge fields from all ancestors (base to child)
      const mergedFields: Record<string, any> = {};
      const mergedMethods: Record<string, any> = {};

      for (const ancestorName of inheritanceChain) {
        const ancestor = objectsByName.get(ancestorName);
        if (!ancestor) continue;

        // Merge fields (child fields override parent fields with same name)
        for (const [fieldName, fieldDef] of Object.entries(ancestor.fields)) {
          if (!mergedFields[fieldName]) {
            mergedFields[fieldName] = fieldDef;
          }
        }

        // Merge methods (child methods override parent methods)
        for (const [methodName, methodDef] of Object.entries(
          ancestor.methods || {},
        )) {
          if (!mergedMethods[methodName]) {
            mergedMethods[methodName] = methodDef;
          }
        }
      }

      // Add child's own fields (override any parent fields with same name)
      for (const [fieldName, fieldDef] of Object.entries(obj.fields)) {
        mergedFields[fieldName] = fieldDef;
      }

      // Add child's own methods
      for (const [methodName, methodDef] of Object.entries(obj.methods || {})) {
        mergedMethods[methodName] = methodDef;
      }

      // Update object definition with merged fields
      obj.fields = mergedFields;
      obj.methods = mergedMethods;

      // Inherit tableName and collection from STI base class
      // STI subclasses share the parent's table, so they should use the same collection name
      const stiBase = this.findSTIBase(obj, objectsByName, manifest);
      if (stiBase && stiBase !== obj) {
        // Determine the STI base's table name (explicit or derived from className)
        // Note: We don't use stiBase.collection as fallback because collection uses
        // lowercase-only format (e.g., 'querytestevents') while tableName needs
        // snake_case format (e.g., 'query_test_events')
        const baseTableName =
          stiBase.decoratorConfig?.tableName ||
          this.classNameToTableName(stiBase.className);

        // Inherit tableName from STI base
        obj.decoratorConfig = obj.decoratorConfig || {};
        obj.decoratorConfig.tableName = baseTableName;
        console.log(
          `[manifest-generator] ${obj.className} inherits tableName: '${baseTableName}' from ${stiBase.className}`,
        );

        // Inherit tableStrategy from STI base (so runtime doesn't need to walk inheritance chain)
        if (stiBase.decoratorConfig?.tableStrategy) {
          obj.decoratorConfig.tableStrategy =
            stiBase.decoratorConfig.tableStrategy;
          console.log(
            `[manifest-generator] ${obj.className} inherits tableStrategy: '${stiBase.decoratorConfig.tableStrategy}' from ${stiBase.className}`,
          );
        }

        // Inherit collection name from STI base (all STI classes share one table)
        if (stiBase.collection !== obj.collection) {
          console.log(
            `[manifest-generator] ${obj.className} inherits collection: '${stiBase.collection}' from ${stiBase.className}`,
          );
          obj.collection = stiBase.collection;
        }
      }

      console.log(
        `[manifest-generator] ✅ ${obj.className} now has ${Object.keys(mergedFields).length} fields (including inherited)`,
      );
    }

    // SECOND PASS: Handle collection classes that should inherit from their item class
    // This must happen AFTER STI field merging so item classes have their tableName set
    for (const obj of Object.values(manifest.objects)) {
      // Check if this is a collection class (extends SmrtCollection)
      const isCollection =
        obj.extends === 'SmrtCollection' ||
        this.extendsCollection(obj, objectsByName);

      if (isCollection) {
        // Find the item class from _itemClass static property
        const itemClass = this.findItemClass(obj, manifest, objectsByName);

        if (itemClass) {
          console.log(
            `[manifest-generator] ${obj.className} is a collection class for ${itemClass.className}`,
          );

          // Inherit tableName from item class (which may have inherited it from STI base)
          if (itemClass.decoratorConfig?.tableName) {
            obj.decoratorConfig = obj.decoratorConfig || {};
            obj.decoratorConfig.tableName = itemClass.decoratorConfig.tableName;
            console.log(
              `[manifest-generator] ${obj.className} inherits tableName: '${itemClass.decoratorConfig.tableName}' from item class ${itemClass.className}`,
            );
          }

          // Inherit collection name from item class
          if (itemClass.collection !== obj.collection) {
            console.log(
              `[manifest-generator] ${obj.className} inherits collection: '${itemClass.collection}' from item class ${itemClass.className} (was '${obj.collection}')`,
            );
            obj.collection = itemClass.collection;
          }
        }
      }
    }
  }

  /**
   * Check if a class extends SmrtCollection (directly or indirectly)
   *
   * @param obj - The object definition to check
   * @param objectsByName - Map of className -> objectDef for lookups
   * @returns true if this class extends SmrtCollection
   */
  private extendsCollection(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): boolean {
    if (!obj.extends) return false;

    // Walk up inheritance chain looking for SmrtCollection
    let currentClass: string | undefined = obj.extends;
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) break;
      visited.add(currentClass);

      if (currentClass === 'SmrtCollection') return true;

      const parentObj = objectsByName.get(currentClass);
      if (!parentObj) break;

      currentClass = parentObj.extends;
    }

    return false;
  }

  /**
   * Find the item class for a collection class
   *
   * Lookup priority:
   * 1. extendsTypeArg - Generic type argument from extends clause (e.g., "Meeting" from SmrtCollection<Meeting>)
   * 2. _itemClass static property - May be captured by AST scanner
   * 3. Name-based inference - Fallback (e.g., "Meetings" -> "Meeting")
   *
   * @param collectionObj - The collection class definition
   * @param manifest - The manifest
   * @param objectsByName - Map of className -> objectDef for lookups
   * @returns Item class definition or undefined
   */
  private findItemClass(
    collectionObj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    // PRIORITY 1: Use generic type argument from extends clause
    // This is the most reliable method: SmrtCollection<Meeting> -> "Meeting"
    if (collectionObj.extendsTypeArg) {
      const itemClassName = collectionObj.extendsTypeArg;
      console.log(
        `[manifest-generator] ${collectionObj.className} has extendsTypeArg: ${itemClassName}`,
      );

      // Try to find the item class by name in local manifest
      const itemClass = objectsByName.get(itemClassName);
      if (itemClass) {
        console.log(
          `[manifest-generator] Found item class ${itemClassName} in local manifest`,
        );
        return itemClass;
      }

      // Try loading from external packages
      if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
        const externalItemClass = this.loadParentFromExternalPackage(
          itemClassName,
          manifest.smrtDependencies,
          objectsByName,
        );
        if (externalItemClass) {
          console.log(
            `[manifest-generator] Found item class ${itemClassName} in external package`,
          );
          return externalItemClass;
        }
      }
    }

    // PRIORITY 2: Look for _itemClass static field in the collection class
    // This is defined like: static readonly _itemClass = Meeting;
    // Note: AST scanner currently skips static properties, so this rarely works
    const itemClassField = collectionObj.fields._itemClass;

    if (itemClassField) {
      // Extract class name from the field's default value or metadata
      // The AST scanner might capture this as a reference
      const itemClassName = itemClassField.related || itemClassField.default;

      if (itemClassName && typeof itemClassName === 'string') {
        // Try to find the item class by name
        const itemClass = objectsByName.get(itemClassName);
        if (itemClass) {
          return itemClass;
        }

        // Try loading from external packages
        if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
          return this.loadParentFromExternalPackage(
            itemClassName,
            manifest.smrtDependencies,
            objectsByName,
          );
        }
      }
    }

    // PRIORITY 3: Fallback - Try to infer from collection class name
    // Generate candidate item class names and check if they exist
    const collectionName = collectionObj.className;
    const candidates: string[] = [];

    // Strip "Collection" suffix first if present
    let baseName = collectionName;
    if (baseName.endsWith('Collection')) {
      baseName = baseName.slice(0, -'Collection'.length);
    }

    // Generate singularization candidates (order matters - try most specific first)
    // 1. Exact name (e.g., "Event" from "EventCollection")
    candidates.push(baseName);

    // 2. Remove trailing 's' (e.g., "Meetings" -> "Meeting")
    if (baseName.endsWith('s') && baseName.length > 1) {
      candidates.push(baseName.slice(0, -1));
    }

    // 3. Handle 'ies' -> 'y' (e.g., "Categories" -> "Category")
    if (baseName.endsWith('ies') && baseName.length > 3) {
      candidates.push(`${baseName.slice(0, -3)}y`);
    }

    // 4. Handle 'es' -> '' for words ending in s/x/z/ch/sh (e.g., "Statuses" -> "Status")
    if (baseName.endsWith('es') && baseName.length > 2) {
      candidates.push(baseName.slice(0, -2));
    }

    // Try each candidate against local classes first, then external packages
    // Skip candidates that match the collection class itself
    for (const candidate of candidates) {
      if (candidate === collectionObj.className) continue; // Don't match self
      const itemClass = objectsByName.get(candidate);
      if (itemClass) {
        return itemClass;
      }
    }

    // Try loading from external packages
    if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
      for (const candidate of candidates) {
        if (candidate === collectionObj.className) continue; // Don't match self
        const itemClass = this.loadParentFromExternalPackage(
          candidate,
          manifest.smrtDependencies,
          objectsByName,
        );
        if (itemClass) {
          return itemClass;
        }
      }
    }

    return undefined;
  }

  /**
   * Check if a class uses STI (either explicitly or inherited from an ancestor)
   *
   * Walks up the inheritance chain to find if any ancestor has tableStrategy: 'sti'.
   * If found, all descendants inherit STI and should have fields merged.
   * Also checks external SMRT packages for parent class definitions.
   *
   * @param obj - The object definition to check
   * @param objectsByName - Map of className -> objectDef for lookups
   * @param manifest - The manifest (for accessing smrtDependencies)
   * @returns true if this class uses STI (directly or inherited)
   */
  private isSTIClass(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest: SmartObjectManifest,
  ): boolean {
    // Check if explicitly marked as STI
    if (obj.decoratorConfig?.tableStrategy === 'sti') {
      return true;
    }

    // Walk up the inheritance chain looking for STI base
    let currentClass: string | undefined = obj.extends;
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) {
        break; // Circular inheritance, stop
      }
      visited.add(currentClass);

      let parentDef = objectsByName.get(currentClass);

      // If parent not in current manifest, try loading from external SMRT packages
      if (
        !parentDef &&
        manifest.smrtDependencies &&
        manifest.smrtDependencies.length > 0
      ) {
        parentDef = this.loadParentFromExternalPackage(
          currentClass,
          manifest.smrtDependencies,
          objectsByName,
        );
      }

      if (!parentDef) break; // Parent not found anywhere

      // Check if this ancestor uses STI
      if (parentDef.decoratorConfig?.tableStrategy === 'sti') {
        return true; // Found STI ancestor
      }

      currentClass = parentDef.extends;
    }

    return false; // No STI in hierarchy
  }

  /**
   * Find the STI base class for a given object
   *
   * Walks up the inheritance chain to find the first ancestor that defines
   * tableStrategy: 'sti'. This is the class that owns the shared table.
   *
   * @param obj - The object definition to find the STI base for
   * @param objectsByName - Map of className -> objectDef for lookups
   * @param manifest - The manifest (for accessing smrtDependencies)
   * @returns The STI base class definition, or the object itself if it's the base
   */
  private findSTIBase(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest: SmartObjectManifest,
  ): SmartObjectDefinition | undefined {
    // Track the oldest STI class found as we walk up
    let stiBase: SmartObjectDefinition | undefined;

    // If this object explicitly defines STI, it's a candidate (but ancestors may also be STI)
    if (obj.decoratorConfig?.tableStrategy === 'sti') {
      stiBase = obj;
    }

    // Walk up the inheritance chain looking for the oldest STI base
    let currentClass: string | undefined = obj.extends;
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) {
        break; // Circular inheritance, stop
      }
      visited.add(currentClass);

      let parentDef = objectsByName.get(currentClass);

      // If parent not in current manifest, try loading from external SMRT packages
      if (
        !parentDef &&
        manifest.smrtDependencies &&
        manifest.smrtDependencies.length > 0
      ) {
        parentDef = this.loadParentFromExternalPackage(
          currentClass,
          manifest.smrtDependencies,
          objectsByName,
        );
      }

      if (!parentDef) break; // Parent not found anywhere

      // Check if this ancestor defines STI - if so, it becomes the new candidate base
      // (we keep walking to find the oldest/root STI class)
      if (parentDef.decoratorConfig?.tableStrategy === 'sti') {
        stiBase = parentDef;
      }

      currentClass = parentDef.extends;
    }

    return stiBase; // Return the oldest STI ancestor found (or undefined if none)
  }

  /**
   * Load parent class definition from external SMRT packages
   *
   * When a child class extends a parent from an external package (e.g., praeco's Council extends
   * smrt-profiles' Organization), this method loads the parent's manifest and extracts the
   * parent's field definitions.
   *
   * @param parentClassName - Name of the parent class to find
   * @param smrtDependencies - List of external SMRT packages to search
   * @param objectsByName - Map to cache loaded external objects
   * @returns Parent object definition if found, undefined otherwise
   */
  private loadParentFromExternalPackage(
    parentClassName: string,
    smrtDependencies: string[],
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    // Try each external SMRT dependency
    for (const packageName of smrtDependencies) {
      const externalManifest = loadExternalManifestSync(packageName);

      if (!externalManifest) {
        continue;
      }

      // Use lookupInManifest for O(1) lookup via cached className index
      // Handles both qualified names and simple class names
      const parentObj = lookupInManifest(externalManifest, parentClassName);

      if (parentObj) {
        // Cache the loaded parent object for future lookups
        objectsByName.set(parentObj.className, parentObj);
        objectsByName.set(parentObj.className.toLowerCase(), parentObj);

        return parentObj;
      }
    }

    return undefined;
  }

  /**
   * Determine import path from package.json exports
   *
   * Tries the following strategies in order:
   * 1. package.json exports["./objects"] - Specific objects export
   * 2. package.json exports["."] - Main export
   * 3. package.json main - Main field
   * 4. Fallback to package name
   */
  private determineImportPath(packageJson: any, _filePath?: string): string {
    const packageName = packageJson.name;

    // Strategy 1: Check for specific exports
    if (packageJson.exports) {
      // Check for objects export
      if (packageJson.exports['./objects']) {
        return `${packageName}/objects`;
      }

      // Check for main export
      const mainExport = packageJson.exports['.'];
      if (mainExport) {
        // Handle conditional exports
        if (typeof mainExport === 'object') {
          if (mainExport.import) {
            return packageName;
          }
          if (mainExport.default) {
            return packageName;
          }
        }
        return packageName;
      }
    }

    // Strategy 2: Check main field
    if (packageJson.main) {
      return packageName;
    }

    // Strategy 3: Fallback to package name
    return packageName;
  }

  /**
   * Generate TypeScript interfaces from manifest
   */
  generateTypeDefinitions(manifest: SmartObjectManifest): string {
    const interfaces: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      interfaces.push(this.generateInterface(obj));
    }

    return interfaces.join('\n\n');
  }

  /**
   * Generate a single interface definition
   */
  private generateInterface(obj: SmartObjectDefinition): string {
    const fields = Object.entries(obj.fields)
      .map(([name, field]) => {
        const optional = !field.required ? '?' : '';
        const type = this.mapFieldTypeToTS(field.type);
        return `  ${name}${optional}: ${type};`;
      })
      .join('\n');

    return `export interface ${obj.className}Data {
${fields}
}`;
  }

  /**
   * Map field types to TypeScript types
   */
  private mapFieldTypeToTS(fieldType: string): string {
    switch (fieldType) {
      case 'text':
        return 'string';
      case 'decimal':
        return 'number';
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'datetime':
        return 'Date | string';
      case 'json':
        return 'any';
      case 'foreignKey':
        return 'string';
      default:
        return 'any';
    }
  }

  /**
   * Generate simple endpoint list for testing/documentation
   */
  generateRestEndpoints(manifest: SmartObjectManifest): string {
    const endpoints: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(...this.getSimpleEndpoints(obj));
      }
    }

    return endpoints.join('\n');
  }

  /**
   * Generate REST endpoint code implementations
   */
  generateRestEndpointCode(manifest: SmartObjectManifest): string {
    const endpoints: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(this.generateRestEndpoint(obj));
      }
    }

    return endpoints.join('\n\n');
  }

  /**
   * Get simple endpoint strings for an object
   */
  private getSimpleEndpoints(obj: SmartObjectDefinition): string[] {
    const { collection } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const endpoints: string[] = [];

    // Determine which operations to include
    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      endpoints.push(`GET /${collection}`);
    }
    if (shouldInclude('create')) {
      endpoints.push(`POST /${collection}`);
    }
    if (shouldInclude('get')) {
      endpoints.push(`GET /${collection}/:id`);
    }
    if (shouldInclude('update')) {
      endpoints.push(`PUT /${collection}/:id`);
    }
    if (shouldInclude('delete')) {
      endpoints.push(`DELETE /${collection}/:id`);
    }

    return endpoints;
  }

  /**
   * Generate a single REST endpoint
   */
  private generateRestEndpoint(obj: SmartObjectDefinition): string {
    const { collection, className } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const operations = [];

    // Determine which operations to include
    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      operations.push(`  // GET /${collection} - List ${collection}`);
      operations.push(`  app.get('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const items = await collection.list(req.query);');
      operations.push('    return Response.json(items);');
      operations.push('  });');
    }

    if (shouldInclude('get')) {
      operations.push(`  // GET /${collection}/:id - Get ${className}`);
      operations.push(
        `  app.get('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const item = await collection.get(req.params.id);');
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`,
      );
      operations.push('    return Response.json(item);');
      operations.push('  });');
    }

    if (shouldInclude('create')) {
      operations.push(`  // POST /${collection} - Create ${className}`);
      operations.push(`  app.post('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const data = await req.json();');
      operations.push('    const item = await collection.create(data);');
      operations.push('    return Response.json(item, { status: 201 });');
      operations.push('  });');
    }

    if (shouldInclude('update')) {
      operations.push(`  // PUT /${collection}/:id - Update ${className}`);
      operations.push(
        `  app.put('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const data = await req.json();');
      operations.push(
        '    const item = await collection.update(req.params.id, data);',
      );
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`,
      );
      operations.push('    return Response.json(item);');
      operations.push('  });');
    }

    if (shouldInclude('delete')) {
      operations.push(`  // DELETE /${collection}/:id - Delete ${className}`);
      operations.push(
        `  app.delete('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push(
        '    const success = await collection.delete(req.params.id);',
      );
      operations.push(
        `    if (!success) return new Response('Not found', { status: 404 });`,
      );
      operations.push(`    return new Response('', { status: 204 });`);
      operations.push('  });');
    }

    return `// ${className} endpoints\n${operations.join('\n')}`;
  }

  /**
   * Generate simple MCP tool names for testing/documentation
   */
  generateMCPTools(manifest: SmartObjectManifest): string {
    const tools: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const mcpConfig = obj.decoratorConfig.mcp;
      if (mcpConfig !== false) {
        tools.push(...this.getSimpleMCPToolNames(obj));
      }
    }

    return tools.join('\n');
  }

  /**
   * Generate MCP tool JSON definitions
   */
  generateMCPToolsCode(manifest: SmartObjectManifest): string {
    const tools: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const mcpConfig = obj.decoratorConfig.mcp;
      if (mcpConfig !== false) {
        tools.push(this.generateMCPTool(obj));
      }
    }

    return `[\n${tools.join(',\n')}\n]`;
  }

  /**
   * Get simple MCP tool names for an object
   */
  private getSimpleMCPToolNames(obj: SmartObjectDefinition): string[] {
    const { collection } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const tools: string[] = [];

    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      tools.push(`list_${collection}`);
    }
    if (shouldInclude('get')) {
      tools.push(`get_${collection}`);
    }
    if (shouldInclude('create')) {
      tools.push(`create_${collection}`);
    }
    if (shouldInclude('update')) {
      tools.push(`update_${collection}`);
    }
    if (shouldInclude('delete')) {
      tools.push(`delete_${collection}`);
    }

    return tools;
  }

  /**
   * Generate a single MCP tool
   */
  private generateMCPTool(obj: SmartObjectDefinition): string {
    const { collection, className, name } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const tools = [];

    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      tools.push(`  {
    name: "list_${collection}",
    description: "List ${collection}",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
        where: { type: "object" }
      }
    }
  }`);
    }

    if (shouldInclude('get')) {
      tools.push(`  {
    name: "get_${name}",
    description: "Get a ${name} by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ${name} ID" }
      },
      required: ["id"]
    }
  }`);
    }

    if (shouldInclude('create')) {
      const requiredFields = Object.entries(obj.fields)
        .filter(([_, field]) => field.required)
        .map(([fieldName]) => fieldName);

      tools.push(`  {
    name: "create_${name}",
    description: "Create a new ${name}",
    inputSchema: {
      type: "object",
      properties: ${JSON.stringify(this.generateSchemaProperties(obj.fields), null, 6)},
      required: ${JSON.stringify(requiredFields)}
    }
  }`);
    }

    return tools.join(',\n');
  }

  /**
   * Generate JSON schema properties for fields
   */
  private generateSchemaProperties(
    fields: Record<string, any>,
  ): Record<string, any> {
    const properties: Record<string, any> = {};

    for (const [name, field] of Object.entries(fields)) {
      properties[name] = {
        type: this.mapFieldTypeToJSON(field.type),
        description: field.description || `The ${name} field`,
      };

      if (field.min !== undefined) properties[name].minimum = field.min;
      if (field.max !== undefined) properties[name].maximum = field.max;
      if (field.minLength !== undefined)
        properties[name].minLength = field.minLength;
      if (field.maxLength !== undefined)
        properties[name].maxLength = field.maxLength;
    }

    return properties;
  }

  /**
   * Map field types to JSON Schema types
   */
  private mapFieldTypeToJSON(fieldType: string): string {
    switch (fieldType) {
      case 'text':
        return 'string';
      case 'decimal':
        return 'number';
      case 'integer':
        return 'integer';
      case 'boolean':
        return 'boolean';
      case 'datetime':
        return 'string';
      case 'json':
        return 'object';
      case 'foreignKey':
        return 'string';
      default:
        return 'string';
    }
  }

  /**
   * Generate agent manifests for Agent subclasses (fifth pass).
   *
   * For any SmartObjectDefinition with `agent` in its decoratorConfig,
   * auto-generates:
   * - Permissions from uiSlots (manage:*) and CLI/MCP methods (execute:*)
   * - Features from uiSlots and exposed methods
   * - Menu items from uiSlots
   * - Component declarations from package.json exports
   *
   * @param manifest - The manifest to process in-place
   * @param packageName - Package name for component export paths
   * @param packageJson - Full package.json for component discovery
   */
  generateAgentManifests(
    manifest: SmartObjectManifest,
    packageName?: string,
    packageJson?: any,
  ): void {
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig.agent) continue;

      const agentConfig = obj.decoratorConfig.agent;
      const slug = obj.className.toLowerCase();
      const uiSlots: Record<string, AgentUISlotManifest> =
        obj.staticProperties?.uiSlots ?? {};

      // Derive permissions
      const permissions: AgentPermission[] = [];

      // From uiSlots: manage:<slotId>
      for (const [slotId, slot] of Object.entries(uiSlots)) {
        permissions.push({
          id: `manage:${slotId}`,
          label: `Manage ${(slot as AgentUISlotManifest).label || slotId}`,
          category: 'slot',
          defaultGranted: true,
        });
      }

      // From CLI/MCP methods: execute:<methodName>
      const exposedMethods = this.getExposedMethods(obj);
      for (const methodName of exposedMethods) {
        permissions.push({
          id: `execute:${methodName}`,
          label: `Execute ${methodName}`,
          category: 'method',
          defaultGranted: true,
        });
      }

      // Derive features
      const features: AgentFeature[] = [];

      for (const [slotId, slot] of Object.entries(uiSlots)) {
        const typedSlot = slot as AgentUISlotManifest;
        features.push({
          id: slotId,
          label: typedSlot.label || slotId,
          description: typedSlot.description,
          type: 'slot',
        });
      }

      for (const methodName of exposedMethods) {
        features.push({
          id: methodName,
          label: methodName,
          type: 'method',
        });
      }

      // Derive menu items from uiSlots (sorted by order)
      const menuItems: AgentMenuItem[] = Object.entries(uiSlots)
        .map(([slotId, slot]) => {
          const typedSlot = slot as AgentUISlotManifest;
          return {
            id: slotId,
            label: typedSlot.label || slotId,
            icon: typedSlot.icon,
            order: typedSlot.order ?? 999,
            path: `/agents/${slug}/${slotId}`,
            requiredPermission: `manage:${slotId}`,
          };
        })
        .sort((a, b) => a.order - b.order);

      // Derive component declarations from package.json exports
      const components: AgentComponentDeclaration[] = [];
      if (packageName && packageJson?.exports) {
        for (const [exportKey, exportValue] of Object.entries(
          packageJson.exports,
        )) {
          // Match patterns like './admin', './town', etc.
          if (exportKey === '.' || exportKey === './manifest') continue;

          // Check if this export has a svelte condition (component export)
          const hasSvelteCondition = this.hasSvelteExport(exportValue);
          if (hasSvelteCondition) {
            const type = exportKey.replace('./', '');
            components.push({
              exportPath: `${packageName}/${type}`,
              type,
            });
          }
        }
      }

      // Capture adminRoutes from static property (same pattern as uiSlots)
      const adminRoutes: AgentAdminRouteManifest[] =
        obj.staticProperties?.adminRoutes ?? [];

      const agentManifest: AgentManifest = {
        name: obj.className,
        slug,
        icon: agentConfig.icon,
        tier: agentConfig.tier || 'free',
        description: agentConfig.description,
        uiSlots,
        permissions,
        features,
        menuItems,
        components,
        ...(adminRoutes.length > 0 ? { adminRoutes } : {}),
      };

      obj.agent = agentManifest;

      console.log(
        `[manifest-generator] Generated agent manifest for ${obj.className}: ` +
          `${permissions.length} permissions, ${features.length} features, ` +
          `${menuItems.length} menu items, ${components.length} components`,
      );
    }
  }

  /**
   * Get deduplicated list of method names exposed via CLI and MCP config
   */
  private getExposedMethods(obj: SmartObjectDefinition): string[] {
    const methods = new Set<string>();

    const cliConfig = obj.decoratorConfig.cli;
    if (cliConfig && typeof cliConfig === 'object' && cliConfig.include) {
      for (const m of cliConfig.include) {
        methods.add(m);
      }
    }

    const mcpConfig = obj.decoratorConfig.mcp;
    if (mcpConfig && typeof mcpConfig === 'object' && mcpConfig.include) {
      for (const m of mcpConfig.include) {
        methods.add(m);
      }
    }

    return Array.from(methods);
  }

  /**
   * Check if an export value has a svelte condition (indicating a component export)
   */
  private hasSvelteExport(exportValue: any): boolean {
    if (!exportValue || typeof exportValue !== 'object') return false;

    // Check for { svelte: ... } condition
    if ('svelte' in exportValue) return true;

    // Check nested conditions like { import: { svelte: ... } }
    for (const val of Object.values(exportValue)) {
      if (val && typeof val === 'object' && 'svelte' in (val as object)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Save manifest to file
   */
  saveManifest(manifest: SmartObjectManifest, filePath: string): void {
    const fs = require('node:fs');
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Load manifest from file
   */
  loadManifest(filePath: string): SmartObjectManifest {
    const fs = require('node:fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }
}

/**
 * Convenience function to generate manifest
 *
 * @param scanResults - Array of scan results containing object definitions
 * @param options - Optional configuration (passed to ManifestGenerator.generateManifest)
 */
export function generateManifest(
  scanResults: ScanResult[],
  options?: {
    packageName?: string;
    packageVersion?: string;
    packageJson?: any;
    smrtDependencies?: string[];
    includeVisibility?: SmrtVisibility[];
  },
): SmartObjectManifest {
  const generator = new ManifestGenerator();
  return generator.generateManifest(scanResults, options);
}
