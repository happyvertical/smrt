/**
 * Manifest generator for creating service manifests from AST scan results
 */

import { createRequire } from 'node:module';
import { loadExternalManifestSync } from '../manifest/manifest-loader.js';
import { generateToolManifest } from '../tools/tool-generator';
import type {
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
} from './types';

// Create require function for synchronous module loading in ESM context
const require = createRequire(import.meta.url);

export class ManifestGenerator {
  /**
   * Generate manifest from scan results
   *
   * @param scanResults - Array of scan results containing object definitions
   * @param options - Optional configuration
   * @param options.packageName - Package name to inject into manifest and object definitions
   * @param options.packageVersion - Package version
   * @param options.packageJson - Full package.json object for determining import paths
   */
  generateManifest(
    scanResults: ScanResult[],
    options?: {
      packageName?: string;
      packageVersion?: string;
      packageJson?: any;
      smrtDependencies?: string[];
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

        // Check for class name collisions
        if (manifest.objects[objectDef.name]) {
          const existing = manifest.objects[objectDef.name];
          throw new Error(
            `Class name collision detected: '${objectDef.className}' is defined in multiple files:\n` +
              `  1. ${existing.filePath}\n` +
              `  2. ${objectDef.filePath}\n\n` +
              `Class names must be unique across the entire codebase. Please rename one of these classes.`,
          );
        }

        manifest.objects[objectDef.name] = objectDef;
      }
    }

    // Second pass: Merge inherited fields for STI classes
    // This ensures STI subclasses have all parent fields inline in the manifest
    this.mergeInheritedFields(manifest);

    // Third pass: Generate schemas for each object (build-time schema generation)
    // This pre-computes DDL, indexes, and columns for efficient external package consumption
    this.generateSchemas(manifest);

    return manifest;
  }

  /**
   * Generate pre-computed schemas for all objects in the manifest
   *
   * This enables external package consumers to use pre-generated schemas
   * without calling generateSchema() at runtime, eliminating latency.
   *
   * @param manifest - The manifest to process in-place
   */
  private generateSchemas(manifest: SmartObjectManifest): void {
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

    // Track which STI bases have been processed (to avoid duplicate schema generation)
    const processedSTIBases = new Set<string>();

    // Build lookup map for checking if base is local
    const localObjects = new Set(
      Object.values(manifest.objects).map((o) => o.className),
    );

    for (const [name, obj] of Object.entries(manifest.objects)) {
      // Determine table name (may have been inherited from external STI base)
      const tableName =
        obj.decoratorConfig?.tableName || this.classNameToTableName(name);

      // Check if this is an STI class
      if (obj.decoratorConfig?.tableStrategy === 'sti') {
        // This is an STI base class - generate STI schema
        if (processedSTIBases.has(name)) continue;
        processedSTIBases.add(name);

        console.log(
          `[manifest-generator] Generating STI schema for ${name} (table: ${tableName})`,
        );

        obj.schema = generator.generateSTISchemaFromManifest(
          name,
          tableName,
          obj.fields,
          manifest,
        );
      } else if (this.isSTIChildClass(obj, manifest)) {
        // This is an STI child class - check if base is LOCAL or EXTERNAL
        const stiBaseClass = this.findSTIBaseClassName(obj, manifest);
        const baseIsLocal = stiBaseClass && localObjects.has(stiBaseClass);

        if (baseIsLocal) {
          // STI base is in this manifest - skip (schema is on base class)
          console.log(
            `[manifest-generator] Skipping schema for STI child ${name} (base ${stiBaseClass} is local)`,
          );
        } else {
          // STI base is EXTERNAL - generate STI schema for this child
          // The child needs its own schema because external package won't include this class
          console.log(
            `[manifest-generator] Generating STI schema for ${name} (external base: ${stiBaseClass}, table: ${tableName})`,
          );

          obj.schema = generator.generateSTISchemaFromManifest(
            name,
            tableName,
            obj.fields,
            manifest,
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
        );
      }
    }
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
   * Find the class name of the STI base class for an object
   *
   * Similar to findSTIBase() but returns just the class name string.
   * Used to determine if the STI base is local or external.
   */
  private findSTIBaseClassName(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): string | undefined {
    if (!obj.extends) return undefined;

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

      if (!parentObj) break;

      if (parentObj.decoratorConfig?.tableStrategy === 'sti') {
        return parentObj.className; // Return the class name
      }

      currentClass = parentObj.extends;
    }

    return undefined;
  }

  /**
   * Convert class name to table name (snake_case pluralized)
   */
  private classNameToTableName(className: string): string {
    return `${className
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '')
      .replace(/s$/, '')}s`;
  }

  /**
   * Merge inherited fields into child classes (build-time inheritance resolution)
   *
   * For STI hierarchies, child classes don't define their own fields in source code
   * (they inherit from parent). This method merges parent fields into child manifests
   * so that runtime code doesn't need to do field resolution.
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

    // Process each object that has a parent (extends another class)
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
        // Determine the STI base's table name (explicit or derived from collection/className)
        const baseTableName =
          stiBase.decoratorConfig?.tableName ||
          stiBase.collection ||
          this.classNameToTableName(stiBase.className);

        // Inherit tableName from STI base
        obj.decoratorConfig = obj.decoratorConfig || {};
        obj.decoratorConfig.tableName = baseTableName;
        console.log(
          `[manifest-generator] ${obj.className} inherits tableName: '${baseTableName}' from ${stiBase.className}`,
        );

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
    // If this object explicitly defines STI, it's the base
    if (obj.decoratorConfig?.tableStrategy === 'sti') {
      return obj;
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

      // Check if this ancestor defines STI
      if (parentDef.decoratorConfig?.tableStrategy === 'sti') {
        return parentDef; // Found STI base
      }

      currentClass = parentDef.extends;
    }

    return undefined; // No STI base found
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

      // Search for parent class in external manifest (case-insensitive)
      const parentKey = Object.keys(externalManifest.objects).find(
        (key) => key.toLowerCase() === parentClassName.toLowerCase(),
      );

      if (parentKey) {
        const parentObj = externalManifest.objects[parentKey];

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
 */
export function generateManifest(
  scanResults: ScanResult[],
): SmartObjectManifest {
  const generator = new ManifestGenerator();
  return generator.generateManifest(scanResults);
}
