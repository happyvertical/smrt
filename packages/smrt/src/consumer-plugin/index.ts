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
      const manifestPath = path.join(
        projectRoot,
        'node_modules',
        packageName,
        'dist',
        'manifest',
        'static-manifest.js',
      );

      if (fs.existsSync(manifestPath)) {
        // Import the manifest
        const manifestModule = await import(manifestPath);
        const manifest =
          manifestModule.staticManifest || manifestModule.default;

        if (manifest?.objects) {
          Object.assign(aggregatedManifest.objects, manifest.objects);
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
