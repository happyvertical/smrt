/**
 * SvelteKit route auto-generation from SMRT objects
 * Generates real TypeScript files in src/routes/api/ based on discovered SMRT objects
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';

export interface SvelteKitOptions {
  enabled: boolean;
  routesDir: string;
  objectsDir: string;
  configPath?: string; // default: 'src/lib/server'
  configFileName?: string; // default: 'smrt.ts'
}

// Keep this aligned with biome.json formatter.lineWidth.
const BIOME_LINE_WIDTH = 80;

/**
 * Extract simple class name from potentially qualified name.
 * Qualified names follow the pattern: @scope/package:ClassName
 *
 * Issue #870: Manifests may contain qualified names which generate invalid
 * import statements like: import { @pkg:Class } from '@pkg'
 *
 * @param qualifiedName - Class name that may be qualified (e.g., "@pkg:Class" or "Class")
 * @returns Simple class name (e.g., "Class")
 */
function extractSimpleClassName(qualifiedName: string): string {
  const colonIndex = qualifiedName.indexOf(':');
  if (colonIndex !== -1) {
    return qualifiedName.substring(colonIndex + 1);
  }
  return qualifiedName;
}

/**
 * Check if an object definition represents a SmrtCollection class.
 * Collection classes share route paths with their item class (via inherited `collection` field),
 * so generating routes for both would cause file collisions.
 */
function isCollectionClass(objectDef: SmartObjectDefinition): boolean {
  return objectDef.extends === 'SmrtCollection';
}

function getRegistrationPackageName(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
  isLocal: boolean,
): string | undefined {
  if (isLocal) {
    return manifest.packageName ?? objectDef.packageName;
  }

  return objectDef.packageName;
}

function toSingleQuotedStringLiteral(value: string): string {
  const jsonLiteral = JSON.stringify(value);
  const jsonContent = jsonLiteral.slice(1, -1).replaceAll("'", "\\'");
  return `'${jsonContent}'`;
}

/**
 * Generates SvelteKit API routes from manifest
 */
export async function generateSvelteKitRoutes(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  if (!options.enabled) return;

  console.log('[smrt] Generating SvelteKit routes...');

  // Generate centralized configuration file first (if it doesn't exist)
  await generateSmrtConfigFile(projectRoot, manifest, options);

  let generatedCount = 0;
  let skippedCollections = 0;
  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    if (isCollectionClass(objectDef)) {
      console.log(
        `[smrt] Skipping ${className} - collection class (routes handled by item class)`,
      );
      skippedCollections++;
      continue;
    }
    await generateRoutesForObject(projectRoot, className, objectDef, options);
    generatedCount++;
  }

  // Update .gitignore to exclude generated routes
  updateGitignore(projectRoot, options);

  const skippedMsg =
    skippedCollections > 0
      ? ` (skipped ${skippedCollections} collection classes)`
      : '';
  console.log(
    `[smrt] Generated routes for ${generatedCount} SMRT objects${skippedMsg}`,
  );
}

/**
 * Generates SMRT object registration file
 * This file imports all SMRT objects to trigger their @smrt() decorators
 */
async function generateRegistrationFile(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  const configPath = options.configPath || 'src/lib/server';
  const configDir = join(projectRoot, configPath);
  const registrationFilePath = join(configDir, 'smrt-register.ts');

  // Group objects by package for efficient imports
  const localObjects: Array<[string, (typeof manifest.objects)[string]]> = [];
  const packageObjects = new Map<string, string[]>(); // packageName -> classNames

  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    if (isLocalObject(projectRoot, objectDef)) {
      // Local object (source in project, not node_modules) - use $lib path
      localObjects.push([className, objectDef]);
    } else if (objectDef.packageName) {
      // External package - group by package name
      const classes = packageObjects.get(objectDef.packageName) || [];
      classes.push(className);
      packageObjects.set(objectDef.packageName, classes);
    } else {
      // No package name and not local - treat as local fallback
      localObjects.push([className, objectDef]);
    }
  }

  // Generate imports for local objects
  // Issue #870: Extract simple class names from qualified names
  const localImports = localObjects
    .map(([className, objectDef]) => {
      const simpleClassName = extractSimpleClassName(className);

      // Calculate direct relative path from the configDir where smrt-register.ts lives
      // to the actual source file of the object.
      let importPath = '';
      if (objectDef.filePath) {
        const relativeToConfig = relative(configDir, objectDef.filePath);
        const normalized = relativeToConfig
          .replace(/\\/g, '/')
          .replace(/\.(ts|js|tsx|jsx)$/, '');
        importPath = normalized.startsWith('.')
          ? normalized
          : `./${normalized}`;
      } else {
        // Fallback for missing file paths
        importPath = getSvelteKitImportPath(
          projectRoot,
          undefined,
          options.objectsDir,
          simpleClassName,
        );
      }

      return `import { ${simpleClassName} } from '${importPath}';`;
    })
    .join('\n');

  // Generate imports for external packages
  // Issue #870: Extract simple class names from qualified names
  const packageImports = Array.from(packageObjects.entries())
    .map(([packageName, classNames]) => {
      // Extract simple class names for valid import syntax
      const simpleNames = classNames.map(extractSimpleClassName);
      return `import { ${simpleNames.join(', ')} } from '${packageName}';`;
    })
    .join('\n');

  const imports = [packageImports, localImports].filter(Boolean).join('\n');
  const registrations = Object.entries(manifest.objects)
    .map(([className, objectDef]) => {
      const simpleClassName = extractSimpleClassName(className);
      const registrationTarget = isCollectionClass(objectDef)
        ? `${simpleClassName} as any`
        : simpleClassName;
      const localObject = isLocalObject(projectRoot, objectDef);
      const packageName = getRegistrationPackageName(
        manifest,
        objectDef,
        localObject,
      );

      if (!packageName) {
        return null;
      }

      const packageNameLiteral = toSingleQuotedStringLiteral(packageName);
      const singleLineRegistration = `ObjectRegistry.register(${registrationTarget}, { packageName: ${packageNameLiteral} });`;

      if (singleLineRegistration.length <= BIOME_LINE_WIDTH) {
        return singleLineRegistration;
      }

      return [
        `ObjectRegistry.register(${registrationTarget}, {`,
        `  packageName: ${packageNameLiteral},`,
        `});`,
      ].join('\n');
    })
    .filter((registration): registration is string => registration !== null)
    .join('\n');

  const registrationContent = `/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which performs
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

${imports}

// Re-register imported objects with explicit package names for bundled runtimes
${registrations}
`;

  // Create directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(registrationFilePath, registrationContent, 'utf-8');
  console.log(`[smrt] Generated registration file: ${registrationFilePath}`);
}

/**
 * Generates centralized SMRT configuration file
 * Only creates if file doesn't exist (preserves user customizations)
 */
async function generateSmrtConfigFile(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  const configPath = options.configPath || 'src/lib/server';
  const configFileName = options.configFileName || 'smrt.ts';
  const configDir = join(projectRoot, configPath);
  const configFilePath = join(configDir, configFileName);

  // Always generate registration file (it gets overwritten)
  await generateRegistrationFile(projectRoot, manifest, options);

  // Don't overwrite existing config file
  if (existsSync(configFilePath)) {
    console.log('[smrt] Config file already exists, skipping generation');
    return;
  }

  const configContent = `/**
 * Centralized SMRT configuration with per-object overrides
 * Generated by @smrt/core vite plugin
 *
 * Most objects will use the default configuration.
 * Add entries to \`objectOverrides\` for objects that need different backends.
 */

// Import SMRT objects to register them via @smrt() decorators
import './smrt-register.js';

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';

/**
 * Per-object configuration overrides
 * Define specific backends for objects that differ from project defaults
 *
 * @example
 * const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
 *   // Analytics uses a separate PostgreSQL database
 *   Analytics: {
 *     db: {
 *       url: process.env.ANALYTICS_DATABASE_URL!,
 *       type: 'postgres'
 *     }
 *   },
 *
 *   // AuditLog uses dedicated database with no AI
 *   AuditLog: {
 *     db: {
 *       url: process.env.AUDIT_DATABASE_URL!,
 *       type: 'postgres'
 *     },
 *     ai: undefined
 *   },
 *
 *   // Cache uses REST adapter (e.g., Redis)
 *   Cache: {
 *     persistence: {
 *       type: 'rest',
 *       baseUrl: process.env.REDIS_URL!
 *     }
 *   }
 * };
 */
const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
  // Add your per-object configuration overrides here
};

/**
 * Default configuration for most SMRT objects
 * Customize this to change project-wide defaults
 */
function getDefaultConfig(): SmrtClassOptions {
  return {
    db: {
      url: process.env.DATABASE_URL || ':memory:',
      type: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite'
    },
    ai: process.env.OPENAI_API_KEY ? {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY
    } : process.env.ANTHROPIC_API_KEY ? {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY
    } : undefined
  };
}

/**
 * Get configuration for a specific SMRT object
 * Merges project defaults with per-object overrides if defined
 */
export function getSmrtConfig(className: string): SmrtClassOptions {
  const defaults = getDefaultConfig();
  const override = objectOverrides[className];

  if (override) {
    // Deep merge: override specific properties while keeping defaults
    return {
      ...defaults,
      ...override,
      // Ensure nested objects are merged properly
      db: override.db
        ? { ...(defaults.db as any), ...(override.db as any) }
        : defaults.db,
      ai: override.ai !== undefined ? override.ai : defaults.ai
    };
  }

  return defaults;
}

/**
 * Helper to get a collection with centralized configuration
 * Automatically applies project defaults or object-specific overrides
 */
export async function getCollection<
  T extends import('@happyvertical/smrt-core').SmrtObject,
>(className: string, overrides: Partial<SmrtClassOptions> = {}) {
  const config = getSmrtConfig(className);

  return await ObjectRegistry.getCollection<T>(
    className,
    {
      ...config,
      ...overrides,
      db: overrides.db
        ? { ...(config.db as any), ...(overrides.db as any) }
        : config.db,
      ai: overrides.ai !== undefined ? overrides.ai : config.ai
    }
  );
}
`;

  // Create directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configFilePath, configContent, 'utf-8');
  console.log(`[smrt] Generated configuration file: ${configFilePath}`);
}

/**
 * Generates route files for a single SMRT object
 */
async function generateRoutesForObject(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  options: SvelteKitOptions,
): Promise<void> {
  const collectionName = objectDef.collection;
  const routeDir = join(projectRoot, options.routesDir, collectionName);

  // Check if API is enabled for this object
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) {
    console.log(`[smrt] Skipping ${className} - API disabled`);
    return;
  }

  // Determine which actions to include
  const standardActions = ['list', 'get', 'create', 'update', 'delete'];
  let includedActions: string[] = [];

  if (apiConfig === true || apiConfig === undefined) {
    // Include all standard actions by default
    includedActions = [...standardActions];
  } else if (typeof apiConfig === 'object') {
    if (apiConfig.include) {
      includedActions = apiConfig.include.filter((action) =>
        standardActions.includes(action),
      );
    } else {
      includedActions = [...standardActions];
    }

    if (apiConfig.exclude && Array.isArray(apiConfig.exclude)) {
      includedActions = includedActions.filter(
        (action) => !apiConfig.exclude?.includes(action),
      );
    }
  }

  // Generate collection route (list, create)
  if (includedActions.includes('list') || includedActions.includes('create')) {
    const collectionRoute = generateCollectionRouteTemplate(
      projectRoot,
      className,
      objectDef,
      includedActions,
      options,
    );
    writeRoute(routeDir, '+server.ts', collectionRoute);
  }

  // Generate item route (get, update, delete)
  if (
    includedActions.includes('get') ||
    includedActions.includes('update') ||
    includedActions.includes('delete')
  ) {
    const itemRoute = generateItemRouteTemplate(
      projectRoot,
      className,
      objectDef,
      includedActions,
      options,
    );
    writeRoute(join(routeDir, '[id]'), '+server.ts', itemRoute);
  }

  // Generate custom action routes
  const customActions = Object.entries(objectDef.methods).filter(
    ([name, method]) =>
      !standardActions.includes(name) &&
      method.isPublic &&
      shouldIncludeInApi(name, apiConfig),
  );

  for (const [actionName, actionDef] of customActions) {
    const actionRoute = generateActionRouteTemplate(
      projectRoot,
      className,
      actionName,
      actionDef,
      objectDef,
      options,
    );
    writeRoute(join(routeDir, '[id]', actionName), '+server.ts', actionRoute);
  }
}

/**
 * Check if a custom action should be included in API
 */
function shouldIncludeInApi(actionName: string, apiConfig: any): boolean {
  if (apiConfig === false) return false;
  if (apiConfig === true || apiConfig === undefined) return true;

  if (typeof apiConfig === 'object') {
    if (apiConfig.include) {
      return apiConfig.include.includes(actionName);
    }
    if (apiConfig.exclude) {
      return !apiConfig.exclude.includes(actionName);
    }
  }

  return true;
}

/**
 * Writes a route file, creating directories as needed
 */
function writeRoute(dir: string, filename: string, content: string): void {
  try {
    // Create directory if needed
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write the file (writeFileSync is synchronous and will throw on failure)
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, 'utf-8');
    console.log(`[smrt] Generated: ${filePath}`);
  } catch (error) {
    console.error(`[smrt] [ERROR] Failed to write route file:`);
    console.error(`[smrt] [ERROR]   Directory: ${dir}`);
    console.error(`[smrt] [ERROR]   Filename: ${filename}`);
    console.error(`[smrt] [ERROR]   Error:`, error);
    throw error;
  }
}

/**
 * Converts absolute file path to SvelteKit $lib alias import
 * For SvelteKit projects, uses $lib alias for better module resolution
 */
function getSvelteKitImportPath(
  projectRoot: string,
  objectFilePath: string | undefined,
  objectsDir: string,
  className?: string,
): string {
  // Handle undefined filePath by generating a default path
  // This allows tests to work without providing explicit file paths
  const filePath =
    objectFilePath ||
    join(projectRoot, objectsDir, `${className || 'Object'}.ts`);

  // Convert objectsDir to absolute path if it's relative
  const absoluteObjectsDir = objectsDir.startsWith('/')
    ? objectsDir
    : join(projectRoot, objectsDir);

  // Get the relative path from objectsDir to the file
  const relativePath = relative(absoluteObjectsDir, filePath);

  // Convert to forward slashes and remove extension
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const withoutExtension = normalizedPath.replace(/\.(ts|js|tsx|jsx)$/, '');

  // If objectsDir is under src/lib, use $lib alias
  if (objectsDir.includes('src/lib')) {
    const libSubpath = objectsDir.split('src/lib')[1] || '';
    const fullPath = libSubpath
      ? `${libSubpath}/${withoutExtension}`
      : withoutExtension;
    return `$lib${fullPath}`.replace(/\/+/g, '/'); // Clean up double slashes
  }

  // Otherwise use relative path (fallback for non-standard layouts)
  return withoutExtension.startsWith('.')
    ? withoutExtension
    : `./${withoutExtension}`;
}

/**
 * Check if an object's source file is local to the project (not in node_modules).
 * The scanner sets packageName for all objects (including local ones from the
 * project's own package.json), so we check the filePath to distinguish.
 */
function isLocalObject(
  projectRoot: string,
  objectDef: SmartObjectDefinition,
): boolean {
  if (!objectDef.filePath) return false;
  return (
    objectDef.filePath.startsWith(projectRoot) &&
    !objectDef.filePath.includes('/node_modules/')
  );
}

/**
 * Generates collection route template (GET list, POST create)
 */
function generateCollectionRouteTemplate(
  _projectRoot: string,
  className: string,
  _objectDef: SmartObjectDefinition,
  includedActions: string[],
  _options: SvelteKitOptions,
): string {
  const hasGet = includedActions.includes('list');
  const hasPost = includedActions.includes('create');

  const imports = `// Auto-generated by @smrt/core vite plugin
// DO NOT EDIT - changes will be overwritten

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCollection } from '$lib/server/smrt';
// Note: ${className} is auto-registered by the Vite plugin scanner
`;

  const getHandler = hasGet
    ? `
// List all ${className.toLowerCase()}s
export const GET: RequestHandler = async ({ url }) => {
  const limit = Number(url.searchParams.get('limit')) || 50;
  const offset = Number(url.searchParams.get('offset')) || 0;

  const collection = await getCollection('${className}');
  const items = await collection.list({ limit, offset });
  const count = await collection.count();

  return json({ items, count, limit, offset });
};
`
    : '';

  const postHandler = hasPost
    ? `
// Create new ${className.toLowerCase()}
export const POST: RequestHandler = async ({ request }) => {
  const data = await request.json();

  const collection = await getCollection('${className}');
  const item = await collection.create(data);
  await item.save();

  return json(item, { status: 201 });
};
`
    : '';

  return imports + getHandler + postHandler;
}

/**
 * Generates item route template (GET, PUT, DELETE)
 */
function generateItemRouteTemplate(
  _projectRoot: string,
  className: string,
  _objectDef: SmartObjectDefinition,
  includedActions: string[],
  _options: SvelteKitOptions,
): string {
  const hasGet = includedActions.includes('get');
  const hasPut = includedActions.includes('update');
  const hasDelete = includedActions.includes('delete');
  const simpleClassName = extractSimpleClassName(className);

  const imports = `// Auto-generated by @smrt/core vite plugin
// DO NOT EDIT - changes will be overwritten

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCollection } from '$lib/server/smrt';
`;

  const getHandler = hasGet
    ? `
// Get single ${simpleClassName.toLowerCase()}
export const GET: RequestHandler = async ({ params }) => {
  const collection = await getCollection<any>('${className}');
  const item = await collection.get(params.id);
  if (!item) throw error(404, '${className} not found');

  return json(item);
};
`
    : '';

  const putHandler = hasPut
    ? `
// Update ${simpleClassName.toLowerCase()}
export const PUT: RequestHandler = async ({ params, request }) => {
  const collection = await getCollection<any>('${className}');
  const item = await collection.get(params.id);
  if (!item) throw error(404, '${className} not found');

  const data = await request.json();
  Object.assign(item, data);
  await item.save();

  return json(item);
};
`
    : '';

  const deleteHandler = hasDelete
    ? `
// Delete ${simpleClassName.toLowerCase()}
export const DELETE: RequestHandler = async ({ params }) => {
  const collection = await getCollection<any>('${className}');
  const item = await collection.get(params.id);
  if (!item) throw error(404, '${className} not found');

  await item.delete();
  return json({ success: true });
};
`
    : '';

  return imports + getHandler + putHandler + deleteHandler;
}

/**
 * Generates custom action route template
 */
function generateActionRouteTemplate(
  _projectRoot: string,
  className: string,
  actionName: string,
  actionDef: any,
  _objectDef: SmartObjectDefinition,
  _options: SvelteKitOptions,
): string {
  const paramsList = actionDef.parameters.map((p: any) => p.name).join(', ');

  return `// Auto-generated by @smrt/core vite plugin
// DO NOT EDIT - changes will be overwritten

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCollection } from '$lib/server/smrt';

// Custom action: ${actionName}
export const POST: RequestHandler = async ({ params, request }) => {
  const collection = await getCollection<any>('${className}');
  const item = await collection.get(params.id);
  if (!item) throw error(404, '${className} not found');

  const options = await request.json();
  const result = await item.${actionName}(${paramsList ? 'options' : ''});

  return json({ action: '${actionName}', result });
};
`;
}

/**
 * Updates .gitignore to exclude auto-generated routes
 */
function updateGitignore(projectRoot: string, options: SvelteKitOptions): void {
  const gitignorePath = join(projectRoot, '.gitignore');

  // Patterns to add
  const patternsToAdd = [
    '# SMRT auto-generated routes (from Vite plugin)',
    `${options.routesDir}/**/+server.ts`,
  ];

  // Read existing .gitignore or create empty string
  let gitignoreContent = '';
  if (existsSync(gitignorePath)) {
    gitignoreContent = readFileSync(gitignorePath, 'utf-8');
  }

  // Check if patterns already exist
  let needsUpdate = false;
  const linesToAdd: string[] = [];

  for (const pattern of patternsToAdd) {
    // Skip if pattern already exists (check for exact match or similar)
    if (!gitignoreContent.includes(pattern)) {
      linesToAdd.push(pattern);
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    // Ensure file ends with newline before adding
    if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
      gitignoreContent += '\n';
    }

    // Add a blank line before our section if file has content
    if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n\n')) {
      gitignoreContent += '\n';
    }

    // Add our patterns
    gitignoreContent += `${linesToAdd.join('\n')}\n`;

    writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
    console.log('[smrt] Updated .gitignore with generated route patterns');
  }
}
