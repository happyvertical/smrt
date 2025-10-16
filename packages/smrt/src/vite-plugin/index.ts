/**
 * Vite plugin for automatic SMRT service generation
 * Provides virtual modules for REST, MCP, and other services
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import type { SmartObjectManifest } from '../scanner/types';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

export interface SmrtPluginOptions {
  /** Glob patterns for SMRT source files */
  include?: string[];
  /** Patterns to exclude */
  exclude?: string[];
  /** Output directory for generated files */
  outDir?: string;
  /** Enable hot module replacement */
  hmr?: boolean;
  /** Watch for file changes */
  watch?: boolean;
  /** Generate types */
  generateTypes?: boolean;
  /** Custom base classes to scan for */
  baseClasses?: string[];
  /** Directory to write TypeScript declarations (relative to project root) */
  typeDeclarationsPath?: string;
  /** Plugin execution mode - controls Node.js vs browser compatibility */
  mode?: 'server' | 'client' | 'auto';
  /** Pre-generated manifest for client mode (avoids file scanning) */
  staticManifest?: SmartObjectManifest;
  /** Path to static manifest file for client mode */
  manifestPath?: string;
  /** SvelteKit route auto-generation options */
  svelteKit?: {
    /** Enable SvelteKit route generation (default: false) */
    enabled: boolean;
    /** Output directory for generated routes (default: 'src/routes/api') */
    routesDir?: string;
    /** Directory containing SMRT objects (default: 'src/lib/objects') */
    objectsDir?: string;
    /** Directory for configuration file (default: 'src/lib/server') */
    configPath?: string;
    /** Configuration file name (default: 'smrt.ts') */
    configFileName?: string;
  };
}

const VIRTUAL_MODULES = {
  '@smrt/routes': 'smrt:routes',
  '@smrt/client': 'smrt:client',
  '@smrt/mcp': 'smrt:mcp',
  '@smrt/types': 'smrt:types',
  '@smrt/manifest': 'smrt:manifest',
  '@smrt/schema': 'smrt:schema',
  '@smrt/ui': 'smrt:ui',
  '@smrt/cli': 'smrt:cli',
};

export function smrtPlugin(options: SmrtPluginOptions = {}): Plugin {
  const {
    include = ['src/**/*.ts', 'src/**/*.js'],
    exclude = ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    hmr = true,
    watch = true,
    generateTypes = true,
    baseClasses = ['SmrtObject', 'SmartObject'],
    typeDeclarationsPath = 'src/types',
    mode = 'auto',
    manifestPath,
    svelteKit = {
      enabled: false,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    },
  } = options;

  let server: ViteDevServer | undefined;
  let manifest: SmartObjectManifest | null = null;
  let manifestGenerator: any = null; // Will be lazily created in server mode
  let pluginMode: 'server' | 'client' = 'server';

  return {
    name: 'smrt-auto-service',

    async configResolved(config) {
      // Detect plugin mode based on build configuration
      if (mode === 'auto') {
        const isSSRBuild = config.build?.ssr;
        const isFederationBuild = config.plugins.some((p) =>
          p.name?.includes('federation'),
        );
        const isClientBuild =
          isFederationBuild ||
          (!isSSRBuild && config.build?.target === 'esnext');

        pluginMode = isClientBuild ? 'client' : 'server';
      } else {
        pluginMode = mode;
      }

      console.log(`[smrt] Running in ${pluginMode} mode`);

      // Scan files and generate initial manifest in all modes
      manifest = await scanAndGenerateManifest();

      // Generate SvelteKit routes if enabled
      if (svelteKit.enabled && manifest) {
        await generateSvelteKitRoutes(config.root, manifest, {
          enabled: svelteKit.enabled,
          routesDir: svelteKit.routesDir || 'src/routes/api',
          objectsDir: svelteKit.objectsDir || 'src/lib/objects',
          configPath: svelteKit.configPath || 'src/lib/server',
          configFileName: svelteKit.configFileName || 'smrt.ts',
        });
      }
    },

    async buildStart() {
      // Rescan files on build start in all modes
      manifest = await scanAndGenerateManifest();
    },

    configureServer(devServer) {
      server = devServer;

      // Serve default HTML when no index.html exists
      devServer.middlewares.use(async (req, res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          try {
            const { existsSync } = await import('node:fs');
            const { join } = await import('node:path');

            const projectRoot = devServer.config.root;
            const indexPath = join(projectRoot, 'index.html');

            // If index.html exists, let Vite handle it
            if (existsSync(indexPath)) {
              return next();
            }

            // Otherwise, serve default SMRT UI
            console.log('[smrt] Serving default UI (no index.html found)');
            let html = getDefaultHTML();

            // Apply Vite's HTML transformation to process module imports
            html = await devServer.transformIndexHtml('/', html);

            res.setHeader('Content-Type', 'text/html');
            res.end(html);
            return;
          } catch (error) {
            console.error('[smrt] Error serving default HTML:', error);
            return next();
          }
        }
        next();
      });

      // Set up file watching in all modes when enabled
      if (watch && hmr) {
        // Watch for file changes
        const watcher = devServer.watcher;

        watcher.on('change', async (file) => {
          if (await shouldRescan(file)) {
            console.log(`[smrt] Rescanning due to change in ${file}`);
            manifest = await scanAndGenerateManifest();

            // Generate SvelteKit routes if enabled
            if (svelteKit.enabled && manifest && server) {
              await generateSvelteKitRoutes(server.config.root, manifest, {
                enabled: svelteKit.enabled,
                routesDir: svelteKit.routesDir || 'src/routes/api',
                objectsDir: svelteKit.objectsDir || 'src/lib/objects',
                configPath: svelteKit.configPath || 'src/lib/server',
                configFileName: svelteKit.configFileName || 'smrt.ts',
              });
            }

            // Invalidate virtual modules
            Object.values(VIRTUAL_MODULES).forEach((id) => {
              const module = server?.moduleGraph.getModuleById(id);
              if (module) {
                server?.reloadModule(module);
              }
            });
          }
        });

        watcher.on('add', async (file) => {
          if (await shouldRescan(file)) {
            console.log(`[smrt] Rescanning due to new file ${file}`);
            manifest = await scanAndGenerateManifest();
          }
        });
      }
    },

    resolveId(id) {
      // Resolve virtual module imports
      if (id in VIRTUAL_MODULES) {
        return `\0${VIRTUAL_MODULES[id as keyof typeof VIRTUAL_MODULES]}`;
      }

      // Resolve virtual index.html for dev UI (only in dev mode)
      if (id === '/index.html' && server) {
        return `\0smrt:index-html`;
      }

      return null;
    },

    async load(id) {
      // Load virtual modules (strip the \0 prefix)
      const cleanId = id.startsWith('\0') ? id.slice(1) : id;

      if (!manifest) {
        manifest = await scanAndGenerateManifest();
      }

      switch (cleanId) {
        case 'smrt:routes':
          // Routes module available in all modes
          return await generateRoutesModule(manifest);

        case 'smrt:client':
          // Client module available in both modes
          return generateClientModule(manifest);

        case 'smrt:mcp':
          // MCP module available in all modes
          return await generateMCPModule(manifest);

        case 'smrt:types':
          // Types module available in both modes
          return await generateTypesModule(manifest, pluginMode);

        case 'smrt:manifest':
          // Manifest module available in both modes
          return generateManifestModule(manifest);

        case 'smrt:schema':
          // Schema module available in both modes
          return await generateSchemaModule(manifest);

        case 'smrt:ui':
          // UI module for default development interface
          return await loadDefaultUI();

        case 'smrt:index-html':
          // Virtual index.html for projects without one
          return await loadDefaultHTML();

        case 'smrt:cli':
          // CLI module for command-line interface generation
          return await generateCLIModule(manifest);

        default:
          return null;
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler: async (html, ctx) => {
        // Only provide default HTML if no index.html exists in project
        if (!server) return html;

        try {
          const { existsSync } = await import('node:fs');
          const { join } = await import('node:path');

          const projectRoot = server.config.root;
          const indexPath = join(projectRoot, 'index.html');

          // If index.html exists, use it as-is
          if (existsSync(indexPath)) {
            return html;
          }

          // Otherwise, provide default SMRT UI
          return await loadDefaultHTML();
        } catch (error) {
          console.error('[smrt] Error checking for index.html:', error);
          return html;
        }
      },
    },
  };

  async function _loadStaticManifest(): Promise<SmartObjectManifest | null> {
    if (!manifestPath) return null;

    try {
      // Conditionally import fs for Node.js environments
      const { readFileSync } = await import('node:fs');
      const manifestContent = readFileSync(manifestPath, 'utf-8');
      return JSON.parse(manifestContent);
    } catch (error) {
      console.warn(
        `[smrt] Could not load static manifest from ${manifestPath}:`,
        error,
      );
      return null;
    }
  }

  function createEmptyManifest(): SmartObjectManifest {
    return {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {},
    };
  }

  async function scanAndGenerateManifest(): Promise<SmartObjectManifest> {
    // In production build, try to use static manifest first
    if (process.env.NODE_ENV === 'production') {
      try {
        const { staticManifest } = await import(
          '../manifest/static-manifest.js'
        );
        if (staticManifest && Object.keys(staticManifest.objects).length > 0) {
          console.log('[smrt] Using pre-generated static manifest');
          return staticManifest;
        }
      } catch (error) {
        console.warn(
          '[smrt] Static manifest not found, falling back to dynamic scanning',
        );
      }
    }

    // Development mode or fallback: use dynamic scanning
    try {
      // Conditionally import Node.js dependencies
      const [{ default: fg }, { ASTScanner, ManifestGenerator }] =
        await Promise.all([import('fast-glob'), import('../scanner/index.js')]);

      // Create manifest generator if not already created
      if (!manifestGenerator) {
        manifestGenerator = new ManifestGenerator();
      }

      // Find all TypeScript files matching patterns
      const sourceFiles = fg.sync(include, {
        ignore: exclude,
        absolute: true,
      });

      if (sourceFiles.length === 0) {
        console.warn('[smrt] No source files found matching patterns');
        return createEmptyManifest();
      }

      // Scan files with AST scanner
      const scanner = new ASTScanner(sourceFiles, {
        baseClasses,
        includePrivateMethods: false,
        includeStaticMethods: true,
        followImports: false,
      });

      const scanResults = scanner.scanFiles();
      const newManifest = manifestGenerator.generateManifest(scanResults);

      // Log scan results
      const objectCount = Object.keys(newManifest.objects).length;
      if (objectCount > 0) {
        const names = Object.keys(newManifest.objects).join(', ');
        console.log(`[smrt] Found ${objectCount} SMRT objects: ${names}`);
      } else {
        console.log('[smrt] No SMRT objects found');
      }

      // Generate TypeScript declarations if enabled
      if (generateTypes && server) {
        await generateTypeDeclarationFile(
          newManifest,
          server.config.root,
          typeDeclarationsPath,
        );
      }

      return newManifest;
    } catch (error) {
      console.error('[smrt] Error scanning files:', error);
      return createEmptyManifest();
    }
  }

  async function shouldRescan(file: string): Promise<boolean> {
    // Only rescan in server mode
    if (pluginMode === 'client') {
      return false;
    }

    try {
      // Conditionally import minimatch
      const { minimatch } = await import('minimatch');

      const isIncluded = include.some((pattern) => minimatch(file, pattern));
      const isExcluded = exclude.some((pattern) => minimatch(file, pattern));

      return isIncluded && !isExcluded;
    } catch (error) {
      console.warn('[smrt] Error checking file patterns:', error);
      return false;
    }
  }
}

/**
 * Generate virtual routes module
 */
async function generateRoutesModule(
  manifest: SmartObjectManifest,
): Promise<string> {
  try {
    const { ManifestGenerator } = await import('../scanner/index.js');
    const generator = new ManifestGenerator();
    const routes = generator.generateRestEndpoints(manifest);

    return `
// Auto-generated REST routes from SMRT objects
// This file is generated automatically - do not edit

export function setupRoutes(app) {
${routes}
}

export { setupRoutes as default };
`;
  } catch (error) {
    console.warn('[smrt] Error generating routes module:', error);
    return 'export function setupRoutes() { console.warn("Routes generation failed"); }';
  }
}

/**
 * Generate virtual client module
 */
function generateClientModule(manifest: SmartObjectManifest): string {
  const objects = Object.entries(manifest.objects);

  const clientMethods = objects
    .map(([name, obj]) => {
      const { collection } = obj;
      return `
  ${name}: {
    list: (params) => fetch(basePath + '/${collection}', { 
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()),
    
    get: (id) => fetch(basePath + '/${collection}/' + id, {
      method: 'GET', 
      headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()),
    
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
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }).then(r => r.ok)
  }`;
    })
    .join(',');

  return `
// Auto-generated API client from SMRT objects
// This file is generated automatically - do not edit

export function createClient(basePath = '/api/v1') {
  return {${clientMethods}
  };
}

export { createClient as default };
`;
}

/**
 * Generate virtual MCP module
 */
async function generateMCPModule(
  manifest: SmartObjectManifest,
): Promise<string> {
  try {
    const { ManifestGenerator } = await import('../scanner/index.js');
    const generator = new ManifestGenerator();
    const tools = generator.generateMCPTools(manifest);

    return `
// Auto-generated MCP tools from SMRT objects  
// This file is generated automatically - do not edit

export const tools = ${tools};

export function createMCPServer() {
  return {
    name: 'smrt-auto-generated',
    version: '1.0.0',
    tools
  };
}

export { createMCPServer as default };
`;
  } catch (error) {
    console.warn('[smrt] Error generating MCP module:', error);
    return 'export const tools = []; export function createMCPServer() { console.warn("MCP generation failed"); return { name: "smrt-client", version: "1.0.0", tools: [] }; }';
  }
}

/**
 * Generate client-mode types without server dependencies
 */
function generateClientModeTypes(manifest: SmartObjectManifest): string {
  const typeDefinitions: string[] = [];

  // Generate interfaces for each object in the manifest
  for (const [objectName, objectMeta] of Object.entries(manifest.objects)) {
    const fields = objectMeta.fields || {};
    const propertyLines: string[] = [];

    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      let type = 'any';

      // Map SMRT field types to TypeScript types
      switch (fieldDef.type) {
        case 'text':
          type = 'string';
          break;
        case 'decimal':
        case 'integer':
          type = 'number';
          break;
        case 'boolean':
          type = 'boolean';
          break;
        case 'datetime':
          type = 'string';
          break;
        case 'json':
          type = 'any';
          break;
        case 'foreignKey':
          type = 'string';
          break;
        default:
          type = 'any';
      }

      const optional = !fieldDef.required ? '?' : '';
      propertyLines.push(`  ${fieldName}${optional}: ${type};`);
    }

    // Add common SmrtObject properties
    propertyLines.unshift(
      '  id?: string;',
      '  created_at?: string;',
      '  updated_at?: string;',
    );

    const interfaceDef = `export interface ${objectName}Data {\n${propertyLines.join('\n')}\n}`;
    typeDefinitions.push(interfaceDef);
  }

  return typeDefinitions.join('\n\n');
}

/**
 * Generate virtual types module
 */
async function generateTypesModule(
  manifest: SmartObjectManifest,
  mode: 'server' | 'client' = 'server',
): Promise<string> {
  let interfaces = '';

  try {
    // Only use scanner in server mode to avoid Node.js dependencies in browser builds
    if (mode !== 'client') {
      const { ManifestGenerator } = await import('../scanner/index.js');
      const generator = new ManifestGenerator();
      interfaces = generator.generateTypeDefinitions(manifest);
    } else {
      // In client mode, generate basic interfaces directly from manifest
      interfaces = generateClientModeTypes(manifest);
    }

    return `
// Auto-generated TypeScript types from SMRT objects
// This file is generated automatically - do not edit

${interfaces}

export interface Request {
  params: Record<string, string>;
  query: Record<string, any>;
  json(): Promise<any>;
}

export interface Response {
  json(data: any, init?: { status?: number }): Response;
  status(code: number): Response;
}
`;
  } catch (error) {
    console.warn('[smrt] Error generating types module:', error);
    return `
// Auto-generated TypeScript types from SMRT objects (fallback)
// This file is generated automatically - do not edit

export interface Request {
  params: Record<string, string>;
  query: Record<string, any>;
  json(): Promise<any>;
}

export interface Response {
  json(data: any, init?: { status?: number }): Response;
  status(code: number): Response;
}
`;
  }
}

/**
 * Generate virtual manifest module
 */
function generateManifestModule(manifest: SmartObjectManifest): string {
  return `
// Auto-generated manifest from SMRT objects
// This file is generated automatically - do not edit

export const manifest = ${JSON.stringify(manifest, null, 2)};

export { manifest as default };
`;
}

/**
 * Generate TypeScript declaration file for virtual modules
 * This eliminates the need for manual type maintenance
 */
async function generateTypeDeclarationFile(
  manifest: SmartObjectManifest,
  projectRoot: string,
  typeDeclarationsPath: string,
): Promise<void> {
  try {
    // Conditionally import path and fs modules
    const [{ join }, { existsSync, mkdirSync, writeFileSync }] =
      await Promise.all([import('node:path'), import('node:fs')]);

    const declarationsDir = join(projectRoot, typeDeclarationsPath);
    const declarationsFile = join(declarationsDir, 'virtual-modules.d.ts');

    // Create directory if it doesn't exist
    if (!existsSync(declarationsDir)) {
      mkdirSync(declarationsDir, { recursive: true });
    }

    // Generate interface definitions for each discovered SMRT object
    const objectInterfaces = Object.entries(manifest.objects)
      .map(([_name, obj]) => {
        const interfaceName = `${obj.className}Data`;
        const fields = Object.entries(obj.fields)
          .map(([fieldName, field]) => {
            const optional = field.required === false ? '?' : '';
            const type = mapTypeScriptType(field.type);
            return `    ${fieldName}${optional}: ${type};`;
          })
          .join('\n');

        return `  export interface ${interfaceName} {
    id?: string;
${fields}
    createdAt?: string;
    updatedAt?: string;
  }`;
      })
      .join('\n\n');

    // Generate CRUD operations interface for each collection
    const collectionNames = [
      ...new Set(Object.values(manifest.objects).map((obj) => obj.collection)),
    ];
    const apiClientInterface = collectionNames
      .map((collection) => {
        const dataType = Object.entries(manifest.objects).find(
          ([, obj]) => obj.collection === collection,
        )?.[1].className;
        const interfaceName = dataType ? `${dataType}Data` : 'any';
        return `    ${collection}: CrudOperations<${interfaceName}>;`;
      })
      .join('\n');

    // Generate MCP tool interfaces based on discovered methods
    const _mcpTools = Object.entries(manifest.objects).flatMap(([_name, obj]) =>
      Object.entries(obj.methods).map(([methodName, method]) => ({
        name: `${methodName}_${obj.collection}`,
        description: `${method.name} operation on ${obj.collection}`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            method.parameters.map((param) => [
              param.name,
              { type: mapJsonSchemaType(param.type) },
            ]),
          ),
          required: method.parameters
            .filter((p) => p.optional !== true)
            .map((p) => p.name),
        },
      })),
    );

    const typeDeclarations = `/**
 * Auto-generated TypeScript declarations for SMRT virtual modules
 * Generated from discovered @smrt() decorated classes
 * 
 * DO NOT EDIT THIS FILE MANUALLY
 * This file is automatically regenerated when SMRT objects change
 */

// Manifest module - Contains discovered SMRT objects metadata
declare module '@smrt/manifest' {
  export interface SmrtObjectField {
    type: string;
    required?: boolean;
    default?: any;
  }

  export interface SmrtObjectMethod {
    name: string;
    parameters: Array<{
      name: string;
      type: string;
      required?: boolean;
    }>;
    returnType: string;
    isAsync: boolean;
  }

  export interface SmrtObjectDefinition {
    className: string;
    collection: string;
    fields: Record<string, SmrtObjectField>;
    methods: Record<string, SmrtObjectMethod>;
    decoratorConfig: any;
  }

  export interface SmrtManifest {
    version: string;
    timestamp: number;
    objects: Record<string, SmrtObjectDefinition>;
  }

  export const manifest: SmrtManifest;
}

// Routes module - Auto-generated REST route setup
declare module '@smrt/routes' {
  export interface RouteApp {
    get(path: string, handler: (req: any, res: any) => void): void;
    post(path: string, handler: (req: any, res: any) => void): void;
    put(path: string, handler: (req: any, res: any) => void): void;
    delete(path: string, handler: (req: any, res: any) => void): void;
  }

  export function setupRoutes(app: RouteApp): void;
  export default setupRoutes;
}

// Client module - Auto-generated API client  
declare module '@smrt/client' {
  export interface ApiResponse<T = any> {
    id?: string;
    data?: T;
    error?: string;
    message?: string;
  }

  export interface CrudOperations<T = any> {
    list(params?: Record<string, any>): Promise<ApiResponse<T[]>>;
    get(id: string): Promise<ApiResponse<T>>;
    create(data: Partial<T>): Promise<ApiResponse<T>>;
    update(id: string, data: Partial<T>): Promise<ApiResponse<T>>;
    delete(id: string): Promise<boolean>;
  }

  export interface ApiClient {
${apiClientInterface}
  }

  export function createClient(basePath?: string): ApiClient;
  export default createClient;
}

// MCP module - Auto-generated Model Context Protocol tools
declare module '@smrt/mcp' {
  export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, any>;
      required?: string[];
    };
  }

  export const tools: McpTool[];
  export function createMCPServer(): { name: string; version: string; tools: McpTool[] };
  export default tools;
}

// Types module - Auto-generated TypeScript interfaces
declare module '@smrt/types' {
  export const types: string;

  // Auto-generated interfaces for discovered SMRT objects
${objectInterfaces}

  export default types;
}

// CLI module - Auto-generated command-line interface
declare module '@smrt/cli' {
  export interface CLIConfig {
    name?: string;
    version?: string;
    description?: string;
    prompt?: boolean;
    colors?: boolean;
  }

  export interface CLIContext {
    db?: any;
    ai?: any;
    user?: {
      id: string;
      roles?: string[];
    };
  }

  export interface CLICommandMap {
    [objectName: string]: {
      collection: string;
      commands: string[];
    };
  }

  export const cliCommands: CLICommandMap;

  export function setupCLI(config?: CLIConfig, context?: CLIContext): {
    run: (argv: string[]) => Promise<void>;
    generator: any;
  };

  export function getCLIHandler(config?: CLIConfig, context?: CLIContext): (argv: string[]) => Promise<void>;

  export default setupCLI;
}`;

    // Write the declarations file
    writeFileSync(declarationsFile, typeDeclarations);
    console.log(
      `[smrt] Generated TypeScript declarations: ${declarationsFile}`,
    );
  } catch (error) {
    console.error('[smrt] Error generating TypeScript declarations:', error);
  }
}

/**
 * Map SMRT field types to TypeScript types
 */
function mapTypeScriptType(smrtType: string): string {
  const typeMap: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    array: 'any[]',
    object: 'Record<string, any>',
    date: 'string',
    Date: 'string',
  };
  return typeMap[smrtType] || 'any';
}

/**
 * Map TypeScript types to JSON Schema types for MCP tools
 */
function mapJsonSchemaType(tsType: string): string {
  const typeMap: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    array: 'array',
    object: 'object',
    any: 'string',
  };
  return typeMap[tsType] || 'string';
}

/**
 * Get default HTML template with inlined JavaScript (inlined for distribution)
 */
function getDefaultHTML(): string {
  const uiScript = getDefaultUIModule();

  // Build HTML without template literals to avoid escaping issues
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>SMRT Development UI</title>\n' +
    '  <style>\n' +
    '    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    '    body {\n' +
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;\n' +
    '      background: #f5f5f5;\n' +
    '      color: #333;\n' +
    '    }\n' +
    '    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }\n' +
    '    header {\n' +
    '      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n' +
    '      color: white;\n' +
    '      padding: 40px 0;\n' +
    '      margin-bottom: 40px;\n' +
    '      box-shadow: 0 4px 6px rgba(0,0,0,0.1);\n' +
    '    }\n' +
    '    header h1 { font-size: 2.5em; font-weight: 700; margin-bottom: 10px; }\n' +
    '    .subtitle { font-size: 1.1em; opacity: 0.9; }\n' +
    '    .stats {\n' +
    '      display: grid;\n' +
    '      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));\n' +
    '      gap: 20px;\n' +
    '      margin-bottom: 40px;\n' +
    '    }\n' +
    '    .stat-card {\n' +
    '      background: white;\n' +
    '      padding: 20px;\n' +
    '      border-radius: 8px;\n' +
    '      box-shadow: 0 2px 4px rgba(0,0,0,0.1);\n' +
    '      text-align: center;\n' +
    '    }\n' +
    '    .stat-value { font-size: 2.5em; font-weight: 700; color: #667eea; margin-bottom: 5px; }\n' +
    '    .stat-label { font-size: 0.9em; color: #666; text-transform: uppercase; letter-spacing: 1px; }\n' +
    '    .collections { display: grid; gap: 30px; }\n' +
    '    .collection-card {\n' +
    '      background: white;\n' +
    '      border-radius: 8px;\n' +
    '      box-shadow: 0 2px 4px rgba(0,0,0,0.1);\n' +
    '      overflow: hidden;\n' +
    '    }\n' +
    '    .collection-header {\n' +
    '      background: #667eea;\n' +
    '      color: white;\n' +
    '      padding: 15px 20px;\n' +
    '      display: flex;\n' +
    '      justify-content: space-between;\n' +
    '      align-items: center;\n' +
    '    }\n' +
    '    .collection-title { font-size: 1.3em; font-weight: 600; }\n' +
    '    .collection-count {\n' +
    '      background: rgba(255,255,255,0.2);\n' +
    '      padding: 5px 15px;\n' +
    '      border-radius: 20px;\n' +
    '      font-size: 0.9em;\n' +
    '    }\n' +
    '    .collection-body { padding: 20px; }\n' +
    '    .field-list {\n' +
    '      display: grid;\n' +
    '      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));\n' +
    '      gap: 15px;\n' +
    '      margin-bottom: 20px;\n' +
    '    }\n' +
    '    .field {\n' +
    '      padding: 10px;\n' +
    '      background: #f8f9fa;\n' +
    '      border-radius: 4px;\n' +
    '      border-left: 3px solid #667eea;\n' +
    '    }\n' +
    '    .field-name { font-weight: 600; color: #333; margin-bottom: 3px; }\n' +
    '    .field-type { font-size: 0.85em; color: #666; }\n' +
    '    .actions { display: flex; gap: 10px; flex-wrap: wrap; }\n' +
    '    .btn {\n' +
    '      padding: 10px 20px;\n' +
    '      border: none;\n' +
    '      border-radius: 4px;\n' +
    '      font-size: 0.9em;\n' +
    '      cursor: pointer;\n' +
    '      transition: all 0.2s;\n' +
    '      text-decoration: none;\n' +
    '      display: inline-block;\n' +
    '    }\n' +
    '    .btn-primary { background: #667eea; color: white; }\n' +
    '    .btn-primary:hover { background: #5568d3; transform: translateY(-1px); }\n' +
    '    .btn-secondary { background: #e0e0e0; color: #333; }\n' +
    '    .btn-secondary:hover { background: #d0d0d0; }\n' +
    '    .loading { text-align: center; padding: 40px; color: #666; }\n' +
    '    .error {\n' +
    '      background: #fee;\n' +
    '      border: 1px solid #fcc;\n' +
    '      color: #c33;\n' +
    '      padding: 15px;\n' +
    '      border-radius: 4px;\n' +
    '      margin-bottom: 20px;\n' +
    '    }\n' +
    '    .empty-state { text-align: center; padding: 60px 20px; color: #999; }\n' +
    '    .empty-state svg { width: 100px; height: 100px; margin-bottom: 20px; opacity: 0.3; }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div id="app">\n' +
    '    <div class="loading">Loading SMRT UI...</div>\n' +
    '  </div>\n' +
    '  <script type="module">\n' +
    uiScript +
    '\n  </script>\n' +
    '</body>\n' +
    '</html>'
  );
}

/**
 * Get default UI module from template file
 * Loads the JavaScript template
 */
function getDefaultUIModule(): string {
  try {
    // Get current file directory
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // Load template file (works in both src and dist)
    const templatePath = join(__dirname, 'templates/default-ui.js');

    return readFileSync(templatePath, 'utf-8').trim();
  } catch (error) {
    console.error('[smrt] Error loading UI template:', error);
    // Fallback to minimal UI
    return `
async function createUI() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '<div class="container" style="padding:40px;text-align:center;"><h1>🎯 SMRT Development UI</h1><p>Template file not found. UI code could not be loaded.</p></div>';
}
createUI();
`;
  }
}

/**
 * Load default HTML template for projects without index.html
 */
async function loadDefaultHTML(): Promise<string> {
  return getDefaultHTML();
}

/**
 * Load default UI module
 */
async function loadDefaultUI(): Promise<string> {
  return getDefaultUIModule();
}

/**
 * Generate virtual CLI module
 */
async function generateCLIModule(
  manifest: SmartObjectManifest,
): Promise<string> {
  try {
    // Import CLI types
    const commands: string[] = [];
    const objectImports: string[] = [];

    // Generate CLI setup code for each object
    for (const [className, objectDef] of Object.entries(manifest.objects)) {
      const config = objectDef.decoratorConfig;
      const cliConfig = config?.cli;

      // Skip if CLI is disabled
      if (cliConfig === false) continue;

      // Determine which operations to include
      const excluded =
        (typeof cliConfig === 'object' ? cliConfig.exclude : []) || [];
      const included =
        typeof cliConfig === 'object' ? cliConfig.include : null;

      const shouldInclude = (command: string) => {
        if (included && !included.includes(command)) return false;
        if (excluded.includes(command)) return false;
        return true;
      };

      // Get collection name
      const collectionName = objectDef.collection;

      // Generate import statement for the object class
      objectImports.push(
        `// Import ${className} and ${className}Collection for CLI operations`,
      );

      // Generate command registration
      const availableCommands: string[] = [];

      // Standard CRUD commands
      if (shouldInclude('list'))
        availableCommands.push(`'${collectionName}:list'`);
      if (shouldInclude('get'))
        availableCommands.push(`'${collectionName}:get'`);
      if (shouldInclude('create'))
        availableCommands.push(`'${collectionName}:create'`);
      if (shouldInclude('update'))
        availableCommands.push(`'${collectionName}:update'`);
      if (shouldInclude('delete'))
        availableCommands.push(`'${collectionName}:delete'`);

      // Custom action methods
      for (const [methodName, method] of Object.entries(objectDef.methods)) {
        // Skip private methods and standard CRUD
        if (
          methodName.startsWith('_') ||
          ['list', 'get', 'create', 'update', 'delete', 'save'].includes(
            methodName,
          )
        )
          continue;

        if (shouldInclude(methodName)) {
          availableCommands.push(`'${collectionName}:${methodName}'`);
        }
      }

      if (availableCommands.length > 0) {
        commands.push(`
  // ${className} commands
  ${className}: {
    collection: '${collectionName}',
    commands: [${availableCommands.join(', ')}]
  }`);
      }
    }

    return `
// Auto-generated CLI module from SMRT objects
// This file is generated automatically - do not edit

import { CLIGenerator } from '@have/smrt/generators/cli';

/**
 * @typedef {import('@have/smrt/generators/cli').CLIConfig} CLIConfig
 * @typedef {import('@have/smrt/generators/cli').CLIContext} CLIContext
 */

${objectImports.join('\n')}

/**
 * Available CLI commands by object
 */
export const cliCommands = {${commands.join(',\n')}
};

/**
 * Setup CLI with auto-generated commands
 *
 * @param {CLIConfig} [config={}] - CLI configuration
 * @param {CLIContext} [context={}] - CLI context
 * @returns {{run: function(string[]): Promise<void>, generator: *}}
 *
 * @example
 * import { setupCLI } from '@smrt/cli';
 *
 * const cli = setupCLI({
 *   name: 'my-app',
 *   version: '1.0.0'
 * });
 *
 * cli.run(process.argv);
 */
export function setupCLI(config = {}, context = {}) {
  const generator = new CLIGenerator(config, context);
  return {
    run: async (argv) => {
      const handler = generator.generateHandler();
      await handler(argv.slice(2)); // Remove 'node' and script name
    },
    generator
  };
}

/**
 * Get CLI handler directly
 *
 * @param {CLIConfig} [config={}] - CLI configuration
 * @param {CLIContext} [context={}] - CLI context
 * @returns {function(string[]): Promise<void>}
 */
export function getCLIHandler(config = {}, context = {}) {
  const generator = new CLIGenerator(config, context);
  return generator.generateHandler();
}

export default setupCLI;
`;
  } catch (error) {
    console.warn('[smrt] Error generating CLI module:', error);
    return `
// Error generating CLI module
export const cliCommands = {};
export function setupCLI() {
  console.warn("CLI generation failed");
  return { run: async () => {} };
}
export function getCLIHandler() {
  return async () => console.warn("CLI generation failed");
}
export default setupCLI;
`;
  }
}

/**
 * Generate virtual schema module with JSON manifests
 */
async function generateSchemaModule(
  manifest: SmartObjectManifest,
): Promise<string> {
  try {
    const { SchemaGenerator } = await import('../schema/index.js');

    const schemaGenerator = new SchemaGenerator();
    const schemas: Record<string, any> = {};

    // Generate schemas for all SMRT objects
    for (const [className, objectDef] of Object.entries(manifest.objects)) {
      const schema = schemaGenerator.generateSchema(objectDef);
      schemas[className] = schema;
    }

    // Create JSON manifest for schemas
    const schemaManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: manifest.packageName || 'unknown',
      schemas: schemas,
      dependencies: Array.from(
        new Set(
          Object.values(schemas).flatMap((s: any) => s.dependencies || []),
        ),
      ),
    };

    return `// Auto-generated schema manifest from SMRT objects
// This file is generated automatically - do not edit

// Schema manifest as JSON for SQL adapters
export const schemaManifest = ${JSON.stringify(schemaManifest, null, 2)};

// Schema registry for runtime access
export const schemas = schemaManifest.schemas;

// Schema lookup function
export function getSchema(className: string) {
  return schemas[className];
}

// All schemas as array for dependency resolution
export const allSchemas = Object.values(schemas);

// Package information
export const packageName = schemaManifest.packageName;
export const dependencies = schemaManifest.dependencies;

export default schemaManifest;`;
  } catch (error) {
    console.error('[smrt] Error generating schema module:', error);
    return `// Error generating schema module
export const schemaManifest = { schemas: {}, dependencies: [] };
export const schemas = {};
export function getSchema() { return null; }
export const allSchemas = [];
export default {};`;
  }
}
