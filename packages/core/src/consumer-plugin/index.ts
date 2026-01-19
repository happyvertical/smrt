/**
 * Vite plugin for consuming SMRT packages
 * Solves virtual module resolution in downstream projects
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'vite';
import { generateDeclarations } from '../prebuild/index.js';

export interface SmrtConsumerOptions {
  /** SMRT packages to scan (e.g., ['@my-org/products', '@my-org/content']) */
  packages?: string[];
  /** Generate TypeScript declarations */
  generateTypes?: boolean;
  /** Output directory for generated types */
  typesDir?: string;
  /** Project root path */
  projectRoot?: string;
  /** SvelteKit integration mode */
  svelteKit?: boolean;
  /** Use static types only (for federation builds) */
  staticTypes?: boolean;
  /** Disable file scanning */
  disableScanning?: boolean;
}

const VIRTUAL_MODULES = {
  '@smrt/routes': 'smrt:routes',
  '@smrt/client': 'smrt:client',
  '@smrt/mcp': 'smrt:mcp',
  '@smrt/types': 'smrt:types',
  '@smrt/manifest': 'smrt:manifest',
};

/**
 * Consumer plugin for projects that use SMRT packages
 */
export function smrtConsumer(options: SmrtConsumerOptions = {}): Plugin {
  const {
    packages = [],
    generateTypes = true,
    typesDir = 'src/types/smrt-generated',
    projectRoot = process.cwd(),
    disableScanning = false,
  } = options;

  let smrtPackages: string[] = [];
  let typeManifest: any = null;
  let typesGenerated = false;

  return {
    name: 'smrt-consumer',

    async buildStart() {
      console.log('[smrt:consumer] Initializing SMRT consumer plugin');

      // Discover SMRT packages if not explicitly specified
      if (packages.length === 0 && !disableScanning) {
        smrtPackages = await discoverSmrtPackages(projectRoot);
      } else {
        smrtPackages = packages;
      }

      if (smrtPackages.length > 0) {
        console.log(
          `[smrt:consumer] Found SMRT packages: ${smrtPackages.join(', ')}`,
        );

        // Aggregate type manifests from discovered packages
        typeManifest = await aggregateTypeManifests(smrtPackages, projectRoot);

        // Save aggregated manifest for CLI discovery
        await saveAggregatedManifest(typeManifest, projectRoot);

        // Generate registration file for CLI class loading
        await generateRegistrationFile(typeManifest, projectRoot);

        // Generate types if requested
        if (generateTypes && !typesGenerated) {
          await generateProjectTypes(typeManifest, typesDir, projectRoot);
          typesGenerated = true;
        }
      } else {
        console.log('[smrt:consumer] No SMRT packages found');
        typeManifest = { version: '1.0.0', timestamp: Date.now(), objects: {} };
      }
    },

    resolveId(id, _importer) {
      // Resolve virtual modules to generated type declarations
      if (id in VIRTUAL_MODULES) {
        const typeFileName = getTypeFileName(id);
        const typePath = path.join(projectRoot, typesDir, typeFileName);

        // If types file exists, resolve to it
        if (fs.existsSync(typePath)) {
          return typePath;
        }

        // Otherwise use virtual module ID for runtime resolution
        return `\0${VIRTUAL_MODULES[id as keyof typeof VIRTUAL_MODULES]}`;
      }
      return null;
    },

    async load(id) {
      // Handle virtual modules if types aren't available
      const cleanId = id.startsWith('\0') ? id.slice(1) : id;

      if (!typeManifest) {
        typeManifest = { version: '1.0.0', timestamp: Date.now(), objects: {} };
      }

      switch (cleanId) {
        case 'smrt:routes':
          return generateFallbackRoutesModule();

        case 'smrt:client':
          return generateFallbackClientModule(typeManifest);

        case 'smrt:mcp':
          return generateFallbackMcpModule();

        case 'smrt:types':
          return generateFallbackTypesModule(typeManifest);

        case 'smrt:manifest':
          return generateFallbackManifestModule(typeManifest);

        default:
          return null;
      }
    },
  };
}

/**
 * Discover SMRT packages in node_modules
 */
async function discoverSmrtPackages(projectRoot: string): Promise<string[]> {
  const packages: string[] = [];
  const nodeModulesPath = path.join(projectRoot, 'node_modules');

  if (!fs.existsSync(nodeModulesPath)) {
    return packages;
  }

  try {
    // Check package.json for workspace dependencies
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
      };

      // Look for packages that likely contain SMRT objects
      for (const [name, version] of Object.entries(allDeps)) {
        if (
          typeof version === 'string' &&
          (name.includes('smrt') ||
            name.includes('@have/') ||
            (await hasSmrtManifest(nodeModulesPath, name)))
        ) {
          packages.push(name);
        }
      }
    }
  } catch (error) {
    console.warn('[smrt:consumer] Error discovering packages:', error);
  }

  return packages;
}

/**
 * Check if a package has SMRT manifest
 */
async function hasSmrtManifest(
  nodeModulesPath: string,
  packageName: string,
): Promise<boolean> {
  const packagePath = path.join(nodeModulesPath, packageName);
  const manifestPath = path.join(
    packagePath,
    'dist',
    'manifest',
    'static-manifest.js',
  );
  return fs.existsSync(manifestPath);
}

/**
 * Aggregate type manifests from multiple packages
 */
async function aggregateTypeManifests(
  packages: string[],
  projectRoot: string,
): Promise<any> {
  const aggregatedManifest = {
    version: '1.0.0',
    timestamp: Date.now(),
    objects: {} as Record<string, any>,
  };

  for (const packageName of packages) {
    try {
      const packageDir = path.join(projectRoot, 'node_modules', packageName);

      // Load package.json for version and export information
      const packageJsonPath = path.join(packageDir, 'package.json');
      let packageJson: any;
      try {
        const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
      } catch {
        console.warn(
          `[smrt:consumer] Could not read package.json for ${packageName}`,
        );
        continue;
      }

      // Try multiple manifest locations
      const manifestCandidates = [
        path.join(packageDir, 'dist', 'manifest', 'static-manifest.js'),
        path.join(packageDir, 'dist', 'manifest.json'),
        path.join(packageDir, 'manifest.json'),
      ];

      for (const manifestPath of manifestCandidates) {
        if (fs.existsSync(manifestPath)) {
          // Import or read the manifest
          let manifest: any;
          if (manifestPath.endsWith('.js')) {
            const manifestModule = await import(manifestPath);
            manifest = manifestModule.staticManifest || manifestModule.default;
          } else {
            const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
            manifest = JSON.parse(manifestContent);
          }

          if (manifest?.objects) {
            console.log(
              `[smrt:consumer] Loaded manifest from ${packageName} (${Object.keys(manifest.objects).length} objects)`,
            );

            // ENHANCED: Preserve package metadata for each object
            for (const [objectName, objectDef] of Object.entries(
              manifest.objects,
            )) {
              const def = objectDef as any;

              aggregatedManifest.objects[objectName] = {
                ...def,
                // Ensure package metadata is preserved/set
                packageName:
                  def.packageName || manifest.packageName || packageName,
                packageVersion:
                  def.packageVersion ||
                  manifest.packageVersion ||
                  packageJson.version,
                // Add fallback import paths if missing
                importPath: def.importPath || determineImportPath(packageJson),
                exportName: def.exportName || def.className || objectName,
                collectionExportName:
                  def.collectionExportName ||
                  `${def.className || objectName}Collection`,
              };
            }

            break; // Use first found manifest for this package
          }
        }
      }
    } catch (error) {
      console.warn(
        `[smrt:consumer] Error loading manifest from ${packageName}:`,
        error,
      );
    }
  }

  return aggregatedManifest;
}

/**
 * Determine import path from package.json
 */
function determineImportPath(packageJson: any): string {
  const packageName = packageJson.name;

  if (!packageName) {
    throw new Error('Package name not found in package.json');
  }

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
 * Save aggregated manifest to .smrt/manifest.json for CLI discovery
 */
async function saveAggregatedManifest(
  manifest: any,
  projectRoot: string,
): Promise<void> {
  const smrtDir = path.join(projectRoot, '.smrt');
  const manifestPath = path.join(smrtDir, 'manifest.json');

  try {
    // Create .smrt directory if it doesn't exist
    if (!fs.existsSync(smrtDir)) {
      fs.mkdirSync(smrtDir, { recursive: true });
    }

    // Write manifest
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    console.log(
      `[smrt:consumer] Saved aggregated manifest to .smrt/manifest.json (${Object.keys(manifest.objects).length} objects)`,
    );
  } catch (error) {
    console.warn('[smrt:consumer] Failed to save aggregated manifest:', error);
  }
}

/**
 * Generate registration file for CLI class loading
 *
 * Creates .smrt/register.js with static imports and registrations
 * for all external SMRT objects discovered during build.
 */
async function generateRegistrationFile(
  manifest: any,
  projectRoot: string,
): Promise<void> {
  const smrtDir = path.join(projectRoot, '.smrt');
  const registerPath = path.join(smrtDir, 'register.js');

  // Build import statements and registrations
  const imports: string[] = [];
  const registrations: string[] = [];
  let externalObjectCount = 0;

  for (const [objectName, objectDef] of Object.entries(manifest.objects)) {
    const def = objectDef as any;

    // Skip local objects (they're imported from local entry point)
    if (!def.packageName || def.packageName === manifest.packageName) {
      continue;
    }

    const importPath = def.importPath || def.packageName;
    const exportName = def.exportName || def.className || objectName;
    const collectionExportName = def.collectionExportName;
    const hasCollection = def.hasCollection; // Check if collection class actually exists
    const tableName = def.collection || objectName.toLowerCase();

    // Generate import statement
    // Only import collection if it exists (hasCollection is truthy)
    if (hasCollection && collectionExportName) {
      imports.push(
        `import { ${exportName}, ${collectionExportName} } from '${importPath}';`,
      );
    } else {
      imports.push(`import { ${exportName} } from '${importPath}';`);
    }

    // Generate registration calls
    // The import above already triggers the @smrt() decorator which registers the class
    // properly with its simple name and qualified name. We call register() again with
    // an empty config just to ensure the class is registered (in case it lacks a decorator).
    // Do NOT pass { name: qualifiedName } as that creates a separate registry entry.
    registrations.push(`ObjectRegistry.register(${exportName}, {});`);

    // Only register collection if it exists
    if (hasCollection && collectionExportName) {
      registrations.push(
        `ObjectRegistry.registerCollection('${tableName}', ${collectionExportName});`,
      );
    }

    externalObjectCount++;
  }

  // Skip generation if no external objects
  if (externalObjectCount === 0) {
    console.log('[smrt:consumer] No external objects - skipping register.js');
    return;
  }

  // Generate file content
  const content = `/**
 * Auto-generated by @happyvertical/smrt-core/consumer-plugin
 * DO NOT EDIT - This file is regenerated on every build
 *
 * Registers SMRT objects from external packages for CLI discovery.
 * Generated at: ${new Date().toISOString()}
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

${imports.join('\n')}

// Register all objects (executed during module evaluation)
${registrations.join('\n')}

export function registerAll() {
  // Objects are already registered during module evaluation
  console.log('[smrt:register] Registered ${externalObjectCount} external objects');
}
`;

  // Create .smrt directory if needed
  if (!fs.existsSync(smrtDir)) {
    fs.mkdirSync(smrtDir, { recursive: true });
  }

  // Write registration file
  fs.writeFileSync(registerPath, content, 'utf-8');

  console.log(
    `[smrt:consumer] Generated .smrt/register.js with ${externalObjectCount} external objects`,
  );
}

/**
 * Generate project-specific types
 */
async function generateProjectTypes(
  typeManifest: any,
  typesDir: string,
  projectRoot: string,
): Promise<void> {
  if (!typeManifest || Object.keys(typeManifest.objects).length === 0) {
    console.log(
      '[smrt:consumer] No SMRT objects found, skipping type generation',
    );
    return;
  }

  await generateDeclarations({
    manifest: typeManifest,
    outDir: typesDir,
    projectRoot,
    includeVirtualModules: true,
    includeObjectTypes: true,
  });

  console.log(
    `[smrt:consumer] Generated types for ${Object.keys(typeManifest.objects).length} objects`,
  );
}

/**
 * Get type file name for virtual module
 */
function getTypeFileName(virtualModule: string): string {
  const moduleMap: Record<string, string> = {
    '@smrt/routes': 'smrt-routes.d.ts',
    '@smrt/client': 'smrt-client.d.ts',
    '@smrt/mcp': 'smrt-mcp.d.ts',
    '@smrt/types': 'smrt-types.d.ts',
    '@smrt/manifest': 'smrt-manifest.d.ts',
  };
  return moduleMap[virtualModule] || 'smrt-unknown.d.ts';
}

/**
 * Fallback modules for when types aren't available
 */
function generateFallbackRoutesModule(): string {
  return `
// Fallback routes module
export function setupRoutes(app) {
  console.warn('[smrt:consumer] No routes available - SMRT packages may not be properly configured');
}
export default setupRoutes;
`;
}

function generateFallbackClientModule(manifest: any): string {
  const objects = Object.entries(manifest?.objects || {});
  if (objects.length === 0) {
    return `
// Fallback client module
export function createClient(basePath = '/api/v1') {
  console.warn('[smrt:consumer] No API client available - SMRT packages may not be properly configured');
  return {};
}
export default createClient;
`;
  }

  // Generate basic client from manifest
  const clientMethods = objects
    .map(([name, obj]: [string, any]) => {
      const { collection } = obj;
      return `
  ${name}: {
    list: () => fetch(basePath + '/${collection}').then(r => r.json()),
    get: (id) => fetch(basePath + '/${collection}/' + id).then(r => r.json()),
    create: (data) => fetch(basePath + '/${collection}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),
    update: (id, data) => fetch(basePath + '/${collection}/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),
    delete: (id) => fetch(basePath + '/${collection}/' + id, {
      method: 'DELETE'
    }).then(r => r.ok)
  }`;
    })
    .join(',');

  return `
// Auto-generated API client from SMRT consumer
export function createClient(basePath = '/api/v1') {
  return {${clientMethods}
  };
}
export default createClient;
`;
}

function generateFallbackMcpModule(): string {
  return `
// Fallback MCP module
export const tools = [];
export function createMCPServer() {
  console.warn('[smrt:consumer] No MCP tools available - SMRT packages may not be properly configured');
  return { name: 'smrt-consumer', version: '1.0.0', tools: [] };
}
export default createMCPServer;
`;
}

function generateFallbackTypesModule(manifest: any): string {
  const objects = Object.entries(manifest?.objects || {});
  if (objects.length === 0) {
    return `// No types available`;
  }

  // Generate basic interfaces
  const interfaces = objects.map(([_name, obj]: [string, any]) => {
    return `export interface ${obj.className}Data {
  id?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: any;
}`;
  });

  return interfaces.join('\n\n');
}

function generateFallbackManifestModule(manifest: any): string {
  return `
// Auto-generated manifest from SMRT consumer
export const manifest = ${JSON.stringify(manifest, null, 2)};
export default manifest;
`;
}
