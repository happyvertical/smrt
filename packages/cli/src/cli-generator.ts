#!/usr/bin/env node

/**
 * CLI command generator for smrt objects
 *
 * Generates admin and development tools from object definitions
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SmrtCollection } from '@happyvertical/smrt-core';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { loadLocalTestManifestSync } from '@happyvertical/smrt-core/manifest';
import {
  type Command,
  type ParsedArgs,
  parseCliArgs,
} from '@happyvertical/utils';

// Read version from package.json (ESM-compatible)
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8'),
);
const CLI_VERSION = packageJson.version;

/**
 * Count required arguments in an args array.
 * Arguments wrapped in [...] are optional, others are required.
 * Examples:
 *   ['id'] -> 1 required
 *   ['[pattern...]'] -> 0 required (optional)
 *   ['id', '[options...]'] -> 1 required
 */
function countRequiredArgs(args: string[] | undefined): number {
  if (!args) return 0;
  return args.filter((arg) => !arg.startsWith('[') || !arg.endsWith(']'))
    .length;
}

// Lazy-load commands to avoid loading tar dependencies unless needed
let _gnodeCommands: Record<string, Command> | null = null;
let _generateCommands: Record<string, Command> | null = null;
let _gitCommands: Record<string, Command> | null = null;
let _initCommands: Record<string, Command> | null = null;
let _utilityCommands: Record<string, Command> | null = null;
let _dispatchCommands: Record<string, Command> | null = null;
let _docsCommands: Record<string, Command> | null = null;
let _playgroundCommands: Record<string, Command> | null = null;

async function getGnodeCommands(): Promise<Record<string, Command>> {
  if (!_gnodeCommands) {
    const { gnodeCommands } = await import('./commands/index.js');
    _gnodeCommands = gnodeCommands;
  }
  return _gnodeCommands;
}

async function getGitCommands(): Promise<Record<string, Command>> {
  if (!_gitCommands) {
    const { gitCommands } = await import('./commands/index.js');
    _gitCommands = gitCommands;
  }
  return _gitCommands;
}

async function getGenerateCommands(): Promise<Record<string, Command>> {
  if (!_generateCommands) {
    const { generateCommands } = await import('./commands/index.js');
    _generateCommands = generateCommands;
  }
  return _generateCommands;
}

async function getInitCommands(): Promise<Record<string, Command>> {
  if (!_initCommands) {
    const { initCommands } = await import('./commands/index.js');
    _initCommands = initCommands;
  }
  return _initCommands;
}

async function getUtilityCommands(): Promise<Record<string, Command>> {
  if (!_utilityCommands) {
    const { utilityCommands } = await import('./commands/index.js');
    _utilityCommands = utilityCommands;
  }
  return _utilityCommands;
}

async function getDispatchCommands(): Promise<Record<string, Command>> {
  if (!_dispatchCommands) {
    const { dispatchCommands } = await import('./commands/index.js');
    _dispatchCommands = dispatchCommands;
  }
  return _dispatchCommands;
}

async function getDocsCommands(): Promise<Record<string, Command>> {
  if (!_docsCommands) {
    const { docsCommands } = await import('./commands/index.js');
    _docsCommands = docsCommands;
  }
  return _docsCommands;
}

async function getPlaygroundCommands(): Promise<Record<string, Command>> {
  if (!_playgroundCommands) {
    const { playgroundCommands } = await import('./commands/index.js');
    _playgroundCommands = playgroundCommands;
  }
  return _playgroundCommands;
}

export interface CLIConfig {
  name?: string;
  version?: string;
  description?: string;
  prompt?: boolean; // Enable interactive prompts
  colors?: boolean; // Enable colored output
}

export interface CLIContext {
  db?: any;
  ai?: any;
  user?: {
    id: string;
    roles?: string[];
  };
  /** Timing data for --timing flag */
  timing?: Record<string, number>;
}

// Re-export Command as CLICommand for backward compatibility
export type CLICommand = Command;

// Re-export ParsedArgs from utils
export type { ParsedArgs } from '@happyvertical/utils';

/**
 * Generate CLI commands for smrt objects
 */
export class CLIGenerator {
  private config: CLIConfig;
  private context: CLIContext;
  private collections = new Map<string, SmrtCollection<any>>();
  private commandCache: CLICommand[] | null = null;
  /** Lazy-loaded cache for object commands (key: objectName lowercase) */
  private objectCommandsCache = new Map<string, CLICommand[]>();
  /** Set of registered object names (lowercase) for quick lookup */
  private registeredObjectNames: Set<string> | null = null;
  /** Whether manifest/classes have been loaded */
  private manifestLoaded = false;

  constructor(config: CLIConfig = {}, context: CLIContext = {}) {
    this.config = {
      name: 'smrt',
      version: CLI_VERSION,
      description: 'Admin CLI for smrt objects',
      prompt: true,
      colors: true,
      ...config,
    };
    this.context = context;
  }

  /**
   * Check if running in test environment
   */
  private isTestMode(): boolean {
    return (
      process.env.NODE_ENV === 'test' ||
      process.env.VITEST === 'true' ||
      typeof (global as any).it === 'function' ||
      typeof (global as any).describe === 'function'
    );
  }

  /**
   * Check if a type string represents an inline object type parameter
   * e.g., "{ meetingId?: string; limit?: number }"
   *
   * Note: Only supports single-level nested braces. Deeply nested types
   * like "{ config: { nested: { deep: string } } }" are not fully supported.
   */
  private isObjectTypeParameter(typeStr: string): boolean {
    return (
      typeStr.includes('{') && typeStr.includes('}') && typeStr.includes(':')
    );
  }

  /**
   * Try to load user's compiled classes for runtime execution
   *
   * Loads both local classes (from project entry point) and external classes
   * (from packages in .smrt/manifest.json) to enable full CLI functionality.
   */
  private async tryLoadUserClasses(): Promise<void> {
    const verbose =
      process.env.SMRT_VERBOSE === 'true' ||
      process.env.DEBUG?.includes('smrt');

    if (verbose) {
      console.log('[CLI] tryLoadUserClasses() called');
    }
    // 1. Load local classes (existing code)
    // Wrap in try/catch so failures don't prevent loading external classes
    try {
      if (verbose) {
        console.log('[CLI] Loading local classes...');
      }
      await this.loadLocalClasses();
    } catch (localError) {
      if (verbose) {
        console.log(
          '[CLI] Local class loading failed (this is OK if using external packages only):',
          localError instanceof Error ? localError.message : 'Unknown error',
        );
      }
    }

    // 2. Load classes from external packages
    if (verbose) {
      console.log('[CLI] Loading external classes...');
    }
    await this.loadExternalClasses();

    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('./config.js');
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    const registeredCount = ObjectRegistry.getAllClasses().size;
    if (verbose || config.verbose) {
      console.log(`[CLI] Successfully loaded ${registeredCount} SMRT objects`);
    }
  }

  /**
   * Load classes from local project entry point
   *
   * Entry point discovery order:
   * 1. smrt.config.js: packages.cli.entryPoint (explicit override)
   * 2. package.json: exports['.'] or main field
   * 3. Fallback: ./dist/index.js
   */
  private async loadLocalClasses(): Promise<void> {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('./config.js');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    // Determine entry point
    let entryPoint: string | null = config.entryPoint;

    if (!entryPoint) {
      try {
        const packageJsonPath = path.resolve(process.cwd(), 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf-8'),
          );

          entryPoint =
            packageJson.exports?.['.']?.import ||
            packageJson.exports?.['.'] ||
            packageJson.main ||
            './dist/index.js';

          if (config.verbose) {
            console.log(
              `[CLI] Detected entry point from package.json: ${entryPoint}`,
            );
          }
        }
      } catch {
        entryPoint = './dist/index.js';
      }
    }

    if (!entryPoint) {
      entryPoint = './dist/index.js';
    }

    const fullPath = path.resolve(process.cwd(), entryPoint);

    if (!fs.existsSync(fullPath)) {
      if (config.verbose) {
        console.log(`[CLI] Entry point not found: ${fullPath}`);
      }
      return;
    }

    if (config.verbose) {
      console.log(`[CLI] Loading local SMRT classes from ${entryPoint}...`);
    }

    const fileUrl = `file://${fullPath}`;
    const importedModule = await import(fileUrl);

    // Register collections from exports
    for (const [exportName, exportValue] of Object.entries(importedModule)) {
      if (exportValue && typeof exportValue === 'function') {
        const itemClass = (exportValue as any)._itemClass;
        if (itemClass) {
          const tableName =
            itemClass.SMRT_TABLE_NAME || itemClass.name.toLowerCase();
          const existing = ObjectRegistry.getClass(tableName);
          if (existing && !existing.collectionConstructor) {
            ObjectRegistry.registerCollection(tableName, exportValue as any);
            if (config.verbose) {
              console.log(`[CLI] Registered local collection ${exportName}`);
            }
          }
        }
      }
    }
  }

  /**
   * Load classes from external packages
   *
   * Imports the auto-generated .smrt/register.js file which contains
   * static imports and registrations for all external SMRT objects.
   *
   * This file is generated by the consumer plugin during build.
   */
  private async loadExternalClasses(): Promise<void> {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('./config.js');
    const { loadLocalTestManifestSync } = await import(
      '@happyvertical/smrt-core/manifest'
    );
    const fs = await import('node:fs');
    const path = await import('node:path');

    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    // CRITICAL: Load manifest BEFORE importing register.js
    // This ensures ObjectRegistry.register() can find manifest entries
    // and load method definitions during registration
    loadLocalTestManifestSync();

    // Check for generated registration file
    const registerPath = path.join(process.cwd(), '.smrt', 'register.js');

    if (!fs.existsSync(registerPath)) {
      // Always show this warning (not just verbose) since it affects custom commands
      console.log(
        '[CLI] No .smrt/register.js found - custom commands may not work',
      );
      console.log('      Run "npm run build" to generate class registrations');
      return;
    }

    try {
      // Import generated registration file
      // This executes the module, which registers all objects
      const fileUrl = `file://${registerPath}`;
      await import(fileUrl);

      if (config.verbose) {
        const count = ObjectRegistry.getAllClasses().size;
        console.log(`[CLI] Loaded ${count} objects from .smrt/register.js`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`\n❌ Failed to load .smrt/register.js: ${msg}`);
      console.error(
        '\nThis usually means an installed package has non-Node.js exports (e.g., .svelte files).',
      );
      console.error('Fix the offending package, then re-run.\n');
      throw error;
    }
  }

  /**
   * Handle exits safely in test mode
   */
  private exitWithError(message: string, code = 1): void {
    if (this.isTestMode()) {
      throw new Error(message);
    }
    console.error(message);
    process.exit(code);
  }

  /**
   * Generate CLI handler function
   */
  generateHandler(): (argv: string[]) => Promise<void> {
    return async (argv: string[]) => {
      // Generate commands (async to load user classes)
      const commands = await this.generateCommands();

      // Preprocess argv to support space-separated object commands
      // Converts: smrt council list → smrt council:list
      // Converts: smrt council get abc-123 → smrt council:get abc-123
      const processedArgv = this.preprocessObjectCommands(argv, commands);

      // Parse args first without built-in commands to avoid loading them unnecessarily
      const parsed = parseCliArgs(processedArgv, commands, {});
      await this.executeCommand(parsed, commands, processedArgv);
    };
  }

  /**
   * Preprocess argv to support space-separated object commands
   *
   * Converts: ['council', 'list'] → ['council:list']
   * Converts: ['council', 'get', 'abc-123'] → ['council:get', 'abc-123']
   *
   * This enables users to type:
   *   smrt council list
   *   smrt council get abc-123
   *   smrt council analyze abc-123 --depth 3
   *
   * Instead of:
   *   smrt council:list
   *   smrt council:get abc-123
   */
  private preprocessObjectCommands(
    argv: string[],
    commands: CLICommand[],
  ): string[] {
    if (argv.length < 2) return argv;

    const firstArg = argv[0];
    const secondArg = argv[1];

    // Skip if first arg is already a colon-separated command
    if (firstArg.includes(':')) return argv;

    // Skip if first arg looks like an option
    if (firstArg.startsWith('-')) return argv;

    // Skip if second arg looks like an option
    if (secondArg.startsWith('-')) return argv;

    // Check if combining first two args would match a command
    const combinedCommand = `${firstArg}:${secondArg}`;
    const matchesCommand = commands.some(
      (cmd) =>
        cmd.name === combinedCommand || cmd.aliases?.includes(combinedCommand),
    );

    if (matchesCommand) {
      // Convert space-separated to colon-separated
      return [combinedCommand, ...argv.slice(2)];
    }

    const knownBuiltInNamespaces = new Set([
      'dispatch',
      'docs',
      'git',
      'playground',
    ]);

    if (knownBuiltInNamespaces.has(firstArg)) {
      return [combinedCommand, ...argv.slice(2)];
    }

    // Also check if first arg is a known object name (for dynamic discovery)
    // This handles cases where manifest-discovered objects might not have
    // all their commands in the static command list yet
    const registeredClasses = ObjectRegistry.getAllClasses();
    // Issue #951: Match by simple name (info.name), not the qualified map key
    const isKnownObject = Array.from(registeredClasses.values()).some(
      (info) => (info.name || '').toLowerCase() === firstArg.toLowerCase(),
    );

    if (isKnownObject) {
      // First arg is a known object, assume second is a method
      return [combinedCommand, ...argv.slice(2)];
    }

    return argv;
  }

  /**
   * Ensure manifest and user classes are loaded.
   * This is the minimum required work before any command can be executed.
   * Separated from command generation to enable lazy command loading.
   */
  private async ensureManifestLoaded(): Promise<void> {
    if (this.manifestLoaded) {
      return;
    }

    const timing = this.context.timing;
    const verbose =
      process.env.SMRT_VERBOSE === 'true' ||
      process.env.DEBUG?.includes('smrt');

    // Load local project manifest
    const manifest = loadLocalTestManifestSync();
    if (verbose) {
      console.log(
        '[CLI] Manifest loaded:',
        manifest
          ? `${Object.keys(manifest.objects || {}).length} objects`
          : 'null',
      );
    }

    if (manifest?.objects) {
      // Register objects from manifest
      for (const [name, objectDef] of Object.entries(manifest.objects)) {
        ObjectRegistry.registerFromManifest(
          name,
          objectDef,
          manifest.packageName,
        );
      }
    }

    // Load actual compiled classes for runtime execution
    const classLoadStart = timing ? performance.now() : 0;
    await this.tryLoadUserClasses();
    if (timing) {
      timing.classLoading = performance.now() - classLoadStart;
    }

    // Build set of registered object names for quick lookup
    // Issue #951: Use simple names (info.name), not qualified map keys
    const registeredClasses = ObjectRegistry.getAllClasses();
    this.registeredObjectNames = new Set(
      Array.from(registeredClasses.values()).map((info) =>
        (info.name || '').toLowerCase(),
      ),
    );

    this.manifestLoaded = true;
  }

  /**
   * Get commands for a specific object (lazy generation with caching)
   */
  private async getObjectCommandsLazy(
    objectName: string,
  ): Promise<CLICommand[]> {
    const lowerName = objectName.toLowerCase();

    // Return cached commands if available
    const cachedCommands = this.objectCommandsCache.get(lowerName);
    if (cachedCommands) {
      return cachedCommands;
    }

    // Find the actual registered class (may have different casing)
    // Issue #951: Match by simple name (info.name), not the qualified map key
    const registeredClasses = ObjectRegistry.getAllClasses();
    let actualName: string | undefined;
    let matchedKey: string | undefined;
    for (const [key, info] of registeredClasses) {
      if ((info.name || key).toLowerCase() === lowerName) {
        actualName = info.name || key;
        matchedKey = key;
        break;
      }
    }

    if (!actualName || !matchedKey) {
      return [];
    }

    // Generate commands for this object using simple name
    const classInfo = registeredClasses.get(matchedKey);
    const commands = await this.generateObjectCommands(actualName, classInfo);

    // Cache the commands
    this.objectCommandsCache.set(lowerName, commands);

    return commands;
  }

  /**
   * Find an object command by name (lazy lookup)
   */
  private async findObjectCommand(
    commandName: string,
  ): Promise<CLICommand | undefined> {
    // Parse command name to extract object name
    // Format: objectname:action (e.g., council:list, event:get)
    const colonIndex = commandName.indexOf(':');
    if (colonIndex === -1) {
      return undefined;
    }

    const objectName = commandName.slice(0, colonIndex);

    // Ensure manifest is loaded so we know what objects exist
    await this.ensureManifestLoaded();

    // Check if this is a known object
    if (!this.registeredObjectNames?.has(objectName.toLowerCase())) {
      return undefined;
    }

    // Get commands for this object (lazy generation)
    const objectCommands = await this.getObjectCommandsLazy(objectName);

    // Find the specific command
    return objectCommands.find(
      (cmd) => cmd.name === commandName || cmd.aliases?.includes(commandName),
    );
  }

  /**
   * Generate all CLI commands
   *
   * NOTE: Object commands are now loaded LAZILY for better startup performance.
   * This method only generates utility commands upfront. Object commands are
   * generated on-demand when executeCommand() looks for them.
   *
   * For full command list (e.g., help display), use generateAllCommands().
   */
  private async generateCommands(): Promise<CLICommand[]> {
    const timing = this.context.timing;
    const verbose =
      process.env.SMRT_VERBOSE === 'true' ||
      process.env.DEBUG?.includes('smrt');

    // Return cached commands if already generated (prevents duplicate execution)
    if (this.commandCache) {
      if (verbose) {
        console.log('[CLI] generateCommands() returning cached commands');
      }
      return this.commandCache;
    }

    if (verbose) {
      console.log('[CLI] generateCommands() starting (lazy mode)');
    }

    // Ensure manifest and classes are loaded
    await this.ensureManifestLoaded();

    // Start timing AFTER class loading to measure only command generation
    const commandGenStart = timing ? performance.now() : 0;

    // Only generate utility commands upfront (small fixed set)
    // Object commands are generated lazily when needed
    const commands: CLICommand[] = [];
    const commandNames = new Set<string>();

    // Add utility commands (with duplicate detection)
    for (const cmd of this.generateUtilityCommands()) {
      if (commandNames.has(cmd.name)) {
        if (verbose) {
          console.warn(`[CLI] Skipping duplicate utility command: ${cmd.name}`);
        }
        continue;
      }
      commandNames.add(cmd.name);
      commands.push(cmd);
    }

    // Record timing
    if (timing) {
      timing.commandGen = performance.now() - commandGenStart;
    }

    // Cache the commands to prevent duplicate generation
    this.commandCache = commands;
    return commands;
  }

  /**
   * Generate ALL commands including lazy-loaded object commands.
   * Used for help display where we need the complete list.
   */
  private async generateAllCommands(): Promise<CLICommand[]> {
    const verbose =
      process.env.SMRT_VERBOSE === 'true' ||
      process.env.DEBUG?.includes('smrt');

    if (verbose) {
      console.log('[CLI] generateAllCommands() - loading all object commands');
    }

    // Ensure manifest and classes are loaded
    await this.ensureManifestLoaded();

    // Start with utility commands
    const allCommands: CLICommand[] = [];
    const commandNames = new Set<string>();

    // Add utility commands first
    for (const cmd of this.generateUtilityCommands()) {
      if (!commandNames.has(cmd.name)) {
        commandNames.add(cmd.name);
        allCommands.push(cmd);
      }
    }

    // Generate all object commands
    // Issue #951: Use simple name for command lookup
    const registeredClasses = ObjectRegistry.getAllClasses();
    for (const [_key, classInfo] of registeredClasses) {
      const objectCommands = await this.getObjectCommandsLazy(
        classInfo.name || _key,
      );
      for (const cmd of objectCommands) {
        if (!commandNames.has(cmd.name)) {
          commandNames.add(cmd.name);
          allCommands.push(cmd);
        }
      }
    }

    return allCommands;
  }

  /**
   * Generate CRUD commands for a specific object
   */
  private async generateObjectCommands(
    objectName: string,
    _classInfo: any,
  ): Promise<CLICommand[]> {
    const commands: CLICommand[] = [];
    const lowerName = objectName.toLowerCase();
    const config = ObjectRegistry.getConfig(objectName);
    const cliConfig = config.cli;

    // Skip if CLI is disabled
    if (cliConfig === false) return commands;

    // Check included/excluded commands
    const excluded =
      (typeof cliConfig === 'object' ? cliConfig.exclude : []) || [];
    const included = typeof cliConfig === 'object' ? cliConfig.include : null;

    const shouldInclude = (
      command: 'list' | 'get' | 'create' | 'update' | 'delete',
    ) => {
      if (included && !included.includes(command)) return false;
      if (excluded.includes(command)) return false;
      return true;
    };

    // LIST command
    if (shouldInclude('list')) {
      commands.push({
        name: `${lowerName}:list`,
        description: `List ${objectName} objects`,
        aliases: [`${lowerName}:ls`],
        options: {
          limit: {
            type: 'string',
            description: 'limit number of results',
            default: '50',
            short: 'l',
          },
          offset: {
            type: 'string',
            description: 'offset for pagination',
            default: '0',
            short: 'o',
          },
          'order-by': { type: 'string', description: 'field to order by' },
          where: { type: 'string', description: 'filter conditions as JSON' },
          format: {
            type: 'string',
            description: 'output format (table|json)',
            default: 'table',
          },
        },
        handler: async (_args, options) => {
          await this.handleList(objectName, options);
        },
      });
    }

    // GET command
    if (shouldInclude('get')) {
      commands.push({
        name: `${lowerName}:get`,
        description: `Get ${objectName} by ID or slug`,
        aliases: [`${lowerName}:show`],
        args: ['id'],
        options: {
          format: {
            type: 'string',
            description: 'output format (json|yaml)',
            default: 'json',
          },
        },
        handler: async (args, options) => {
          await this.handleGet(objectName, args[0], options);
        },
      });
    }

    // CREATE command
    if (shouldInclude('create')) {
      const options: Record<string, any> = {
        interactive: {
          type: 'boolean',
          description: 'interactive mode with prompts',
        },
        'from-file': { type: 'string', description: 'create from JSON file' },
      };

      // Add field options
      const fields = ObjectRegistry.getFields(objectName);
      for (const [fieldName, field] of fields) {
        const optionName = fieldName.replace(/_/g, '-');
        const description =
          field.options?.description || `${objectName} ${fieldName}`;
        options[optionName] = { type: 'string', description };
      }

      commands.push({
        name: `${lowerName}:create`,
        description: `Create new ${objectName}`,
        aliases: [`${lowerName}:new`],
        options,
        handler: async (_args, options) => {
          await this.handleCreate(objectName, options);
        },
      });
    }

    // UPDATE command
    if (shouldInclude('update')) {
      const options: Record<string, any> = {
        interactive: {
          type: 'boolean',
          description: 'interactive mode with prompts',
        },
        'from-file': { type: 'string', description: 'update from JSON file' },
      };

      // Add field options
      const fields = ObjectRegistry.getFields(objectName);
      for (const [fieldName, field] of fields) {
        const optionName = fieldName.replace(/_/g, '-');
        const description =
          field.options?.description || `${objectName} ${fieldName}`;
        options[optionName] = { type: 'string', description };
      }

      commands.push({
        name: `${lowerName}:update`,
        description: `Update ${objectName}`,
        aliases: [`${lowerName}:edit`],
        args: ['id'],
        options,
        handler: async (args, options) => {
          await this.handleUpdate(objectName, args[0], options);
        },
      });
    }

    // DELETE command
    if (shouldInclude('delete')) {
      commands.push({
        name: `${lowerName}:delete`,
        description: `Delete ${objectName}`,
        aliases: [`${lowerName}:rm`],
        args: ['id'],
        options: {
          force: { type: 'boolean', description: 'skip confirmation prompt' },
        },
        handler: async (args, options) => {
          await this.handleDelete(objectName, args[0], options);
        },
      });
    }

    // CUSTOM METHODS - discover from manifest (including inherited methods)
    const methods = await ObjectRegistry.getAllMethods(objectName);

    // Check if include list contains any custom method names (indicates strict mode)
    const crudOperations = ['list', 'get', 'create', 'update', 'delete'];
    const hasCustomMethodsInInclude = included?.some(
      (item) => !crudOperations.includes(item),
    );

    for (const [methodName, methodDef] of methods) {
      // Check if method should be included in CLI
      const shouldIncludeMethod = () => {
        // Skip if not public (private/protected methods shouldn't be in CLI)
        if (!methodDef.isPublic) return false;

        // Always respect exclude list
        if (excluded.includes(methodName)) return false;

        // If include list has custom methods, use strict mode (only show what's in include)
        if (
          hasCustomMethodsInInclude &&
          included &&
          !included.includes(methodName)
        ) {
          return false;
        }

        // Otherwise, show custom methods by default (even if include only has CRUD ops)
        // This allows: cli: { include: ['list', 'get'] } to show list + get + all custom methods
        return true;
      };

      if (!shouldIncludeMethod()) continue;

      // Build options from method parameters
      const methodOptions: Record<string, any> = {
        json: {
          type: 'boolean',
          description: 'Output as JSON only (suppress other output)',
        },
      };

      // Map method parameters to CLI options
      // Handles both flat params and object params like { meetingId?: string; limit?: number }
      // Note: Only supports single-level nested braces in type definitions
      for (const param of methodDef.parameters || []) {
        // Check if param type is an inline object type (contains property definitions)
        const typeStr = param.type || '';
        const isObjectType = this.isObjectTypeParameter(typeStr);

        if (isObjectType) {
          // Parse object type properties into individual CLI options
          // Extract content between outermost { }
          const match = typeStr.match(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
          if (match) {
            const propsStr = match[1];
            // Match property patterns like "meetingId?: string" or "limit?: number"
            const propMatches = propsStr.matchAll(/(\w+)(\?)?:\s*([^;]+)/g);
            for (const propMatch of propMatches) {
              const [, propName, isOptional, propType] = propMatch;
              const optionName = propName
                .replace(/([A-Z])/g, '-$1')
                .toLowerCase();

              // For import() types, accept JSON string
              if (propType.includes('import(')) {
                methodOptions[optionName] = {
                  type: 'string',
                  description: `JSON object${isOptional ? ' (optional)' : ''}`,
                };
              } else {
                const trimmedType = propType.trim();
                methodOptions[optionName] = {
                  type: trimmedType === 'boolean' ? 'boolean' : 'string',
                  description: `${trimmedType}${isOptional ? ' (optional)' : ''}`,
                };
              }
            }
          }
        } else {
          // Flat parameter - create single option
          const optionName = param.name
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase();
          const paramType = (param.type || '').trim();
          methodOptions[optionName] = {
            type: paramType === 'boolean' ? 'boolean' : 'string',
            description: `${param.type}${param.optional ? ' (optional)' : ''}`,
            ...(param.default !== undefined && {
              default: String(param.default),
            }),
          };
        }
      }

      // Determine if method needs an object instance (ID lookup) vs singleton
      // Instance methods: first parameter is explicitly named 'id' → fetch from DB
      // Singleton methods: everything else → create new instance, pass options
      const firstParam = (methodDef.parameters || [])[0];
      const needsInstance = firstParam?.name === 'id';

      commands.push({
        name: `${lowerName}:${methodName}`,
        description:
          methodDef.description || `Execute ${methodName} on ${objectName}`,
        args: needsInstance ? ['id'] : [], // Only require ID if method has required parameters
        options: methodOptions,
        handler: async (args, options) => {
          if (needsInstance) {
            await this.handleCustomMethod(
              objectName,
              args[0],
              methodName,
              options,
            );
          } else {
            await this.handleSingletonMethod(
              objectName,
              methodName,
              options,
              methodDef,
            );
          }
        },
      });
    }

    return commands;
  }

  /**
   * Execute a parsed command
   */
  async executeCommand(
    parsed: ParsedArgs,
    commands: CLICommand[],
    processedArgv: string[] = process.argv.slice(2),
  ): Promise<void> {
    if (!parsed.command) {
      // For help, we need all commands
      const allCommands = await this.generateAllCommands();
      await this.showHelp(allCommands);
      return;
    }

    // First check utility commands from the passed array (already generated)
    let command = commands.find(
      (cmd) =>
        cmd.name === parsed.command ||
        (parsed.command && cmd.aliases && cmd.aliases.includes(parsed.command)),
    );

    // If not found in utility commands, try lazy-loading object commands
    if (!command && parsed.command) {
      command = await this.findObjectCommand(parsed.command);
    }

    if (command) {
      // Validate required arguments (args wrapped in [...] are optional)
      const requiredArgCount = countRequiredArgs(command.args);
      if (parsed.args.length < requiredArgCount) {
        const missingArgs = command.args
          ?.slice(parsed.args.length)
          .filter((arg) => !arg.startsWith('[') || !arg.endsWith(']'));
        this.exitWithError(
          `Missing required arguments: ${missingArgs?.join(', ') || ''}`,
        );
        return;
      }

      // Check if handler exists before invoking
      if (!command.handler) {
        this.exitWithError(
          `Command '${parsed.command}' has no handler defined`,
        );
        return;
      }

      try {
        await command.handler(parsed.args, parsed.options);
        return;
      } catch (error) {
        this.exitWithError(
          `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        return;
      }
    }

    // Only load built-in commands if not found in object commands
    // This avoids loading tar dependencies unless actually needed
    const [
      gnodeCommands,
      generateCommands,
      gitCommands,
      initCommands,
      utilityCommands,
      dispatchCommands,
      docsCommands,
      playgroundCommands,
    ] = await Promise.all([
      getGnodeCommands(),
      getGenerateCommands(),
      getGitCommands(),
      getInitCommands(),
      getUtilityCommands(),
      getDispatchCommands(),
      getDocsCommands(),
      getPlaygroundCommands(),
    ]);
    const builtInCommands = {
      ...gnodeCommands,
      ...generateCommands,
      ...gitCommands,
      ...initCommands,
      ...utilityCommands,
      ...dispatchCommands,
      ...docsCommands,
      ...playgroundCommands,
    };

    const builtInCommand =
      builtInCommands[parsed.command] ??
      Object.values(builtInCommands).find(
        (cmd) =>
          cmd.name === parsed.command ||
          cmd.aliases?.includes(parsed.command ?? ''),
      );
    if (builtInCommand) {
      // Validate required arguments (args wrapped in [...] are optional)
      const requiredArgCount = countRequiredArgs(builtInCommand.args);
      if (parsed.args.length < requiredArgCount) {
        const missingArgs = builtInCommand.args
          ?.slice(parsed.args.length)
          .filter((arg) => !arg.startsWith('[') || !arg.endsWith(']'));
        this.exitWithError(
          `Missing required arguments: ${missingArgs?.join(', ') || ''}`,
        );
        return;
      }

      // Check if handler exists before invoking
      if (!builtInCommand.handler) {
        this.exitWithError(
          `Command '${parsed.command}' has no handler defined`,
        );
        return;
      }

      // Re-parse options for built-in command since they weren't in initial parse
      // The initial parseCliArgs only has object commands, not built-in commands
      const reParsed = parseCliArgs(processedArgv, [builtInCommand], {});

      try {
        await builtInCommand.handler(reParsed.args, reParsed.options);
        return;
      } catch (error) {
        this.exitWithError(
          `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        return;
      }
    }

    // Check if the command matches a registered object name (show help for that object)
    // Issue #951: Match by simple name, not qualified map key
    await this.ensureManifestLoaded();
    const registeredClasses = ObjectRegistry.getAllClasses();
    let matchingObject: string | undefined;
    for (const [_key, info] of registeredClasses) {
      if ((info.name || _key).toLowerCase() === parsed.command?.toLowerCase()) {
        matchingObject = info.name || _key;
        break;
      }
    }

    if (matchingObject) {
      // Lazy load just this object's commands for help
      const objectCommands = await this.getObjectCommandsLazy(matchingObject);
      await this.showObjectHelp(matchingObject, objectCommands);
      return;
    }

    // Command not found in either object or built-in commands
    this.exitWithError(`Unknown command '${parsed.command}'`);
  }

  /**
   * Show help for a specific object and its available commands
   */
  private async showObjectHelp(
    objectName: string,
    objectCommands: CLICommand[],
  ): Promise<void> {
    const classInfo = ObjectRegistry.getClass(objectName);
    const lowerName = objectName.toLowerCase();

    console.log(`\n${objectName}`);
    console.log('='.repeat(objectName.length));

    if (classInfo?.packageName) {
      console.log(`Package: ${classInfo.packageName}`);
    }

    if (objectCommands.length === 0) {
      console.log('\nNo CLI commands available for this object.');
      console.log(
        'Check that cli: true or cli: { include: [...] } is set in @smrt() decorator.',
      );
      return;
    }

    console.log('\nAvailable commands:');
    for (const cmd of objectCommands) {
      const cmdName = cmd.name.replace(`${lowerName}:`, '');
      const args = cmd.args
        ? ` ${cmd.args.map((arg) => `<${arg}>`).join(' ')}`
        : '';
      console.log(`  smrt ${lowerName} ${cmdName}${args}`);
      console.log(`    ${cmd.description}`);

      if (cmd.options && Object.keys(cmd.options).length > 0) {
        for (const [optName, opt] of Object.entries(cmd.options)) {
          const short = opt.short ? `-${opt.short}, ` : '';
          const def = opt.default ? ` (default: ${opt.default})` : '';
          console.log(`      ${short}--${optName}${def}`);
        }
      }
      console.log();
    }

    // Show fields if verbose help requested
    const fields = ObjectRegistry.getFields(objectName);
    if (fields.size > 0) {
      console.log('Fields:');
      for (const [fieldName, field] of fields) {
        const required = field.options?.required ? ' (required)' : '';
        console.log(`  ${fieldName}: ${field.type}${required}`);
      }
    }
  }

  /**
   * Generate utility commands
   */
  generateUtilityCommands(): CLICommand[] {
    const commands: CLICommand[] = [];

    // List all registered objects (from ObjectRegistry)
    commands.push({
      name: 'objects',
      description: 'List all registered smrt objects',
      aliases: ['ls'],
      options: {
        verbose: {
          type: 'boolean',
          description: 'Show detailed output including methods',
          short: 'v',
        },
        json: {
          type: 'boolean',
          description: 'Output as JSON',
        },
      },
      handler: async (_args, options) => {
        // Use ObjectRegistry which has all loaded objects
        const registeredClasses = ObjectRegistry.getAllClasses();

        if (registeredClasses.size === 0) {
          console.log('No SMRT objects found.');
          console.log('\nTo discover objects:');
          console.log('  • Build your project: npm run build');
          console.log('  • Ensure .smrt/register.js exists');
          console.log('  • Run: smrt introspect for details');
          return;
        }

        if (options.json) {
          // JSON output mode
          const output: Record<string, any> = {};
          for (const [key, classInfo] of registeredClasses) {
            // Issue #951: Use qualified key to avoid collisions in JSON output,
            // include simple name as a display field
            const displayName = classInfo.name || key;
            const config = ObjectRegistry.getConfig(key);
            const fields = ObjectRegistry.getFields(key);
            const methods = await ObjectRegistry.getAllMethods(key);

            output[classInfo.qualifiedName || displayName] = {
              name: displayName,
              package: classInfo.packageName || 'project',
              hasConstructor: !!classInfo.constructor,
              hasCollection: !!classInfo.collectionConstructor,
              config,
              fields: Object.fromEntries(fields),
              methods: Object.fromEntries(methods),
            };
          }
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log('Registered SMRT objects:\n');

        // Group by package name
        // Issue #951: Track both simple name (display) and map key (lookups)
        const byPackage = new Map<
          string,
          Array<{ display: string; key: string }>
        >();
        for (const [key, classInfo] of registeredClasses) {
          const pkg = classInfo.packageName || 'project';
          if (!byPackage.has(pkg)) {
            byPackage.set(pkg, []);
          }
          byPackage.get(pkg)?.push({ display: classInfo.name || key, key });
        }

        for (const [pkg, entries] of byPackage) {
          console.log(`  ${pkg}:`);

          for (const { display: objName, key: objKey } of entries) {
            const config = ObjectRegistry.getConfig(objKey);
            const cliConfig = config.cli;

            // Get CLI-enabled methods
            let cliMethods: string[] = [];
            if (cliConfig) {
              const methods = await ObjectRegistry.getAllMethods(objKey);
              const methodNames = Array.from(methods.keys());

              if (typeof cliConfig === 'object' && cliConfig.include) {
                // Filter to included methods
                cliMethods = methodNames.filter(
                  (m) =>
                    cliConfig.include?.includes(m) && methods.get(m)?.isPublic,
                );
              } else if (cliConfig === true) {
                // All public methods
                cliMethods = methodNames.filter(
                  (m) => methods.get(m)?.isPublic,
                );
              }
            }

            if (options.verbose) {
              console.log(`    • ${objName}`);
              if (cliMethods.length > 0) {
                console.log(`      CLI: ${cliMethods.join(', ')}`);
              }
              // Show fields
              const fields = ObjectRegistry.getFields(objKey);
              const fieldNames = Array.from(fields.keys()).slice(0, 5);
              if (fieldNames.length > 0) {
                console.log(
                  `      Fields: ${fieldNames.join(', ')}${fields.size > 5 ? '...' : ''}`,
                );
              }
            } else {
              const methodStr =
                cliMethods.length > 0 ? ` → ${cliMethods.join(', ')}` : '';
              console.log(`    • ${objName}${methodStr}`);
            }
          }
          console.log();
        }

        console.log(
          `Total: ${registeredClasses.size} objects from ${byPackage.size} source(s)`,
        );
      },
    });

    // Schema information
    commands.push({
      name: 'schema',
      description: 'Show schema for an object',
      args: ['object'],
      handler: this.createSchemaHandler(),
    });

    // Help command
    commands.push({
      name: 'help',
      description: 'Show help information',
      aliases: ['h'],
      handler: async (_args, _options) => {
        await this.showHelp(commands);
      },
    });

    // Version command
    commands.push({
      name: 'version',
      description: 'Show version information',
      aliases: ['v'],
      handler: async (_args, _options) => {
        console.log(`${this.config.name} v${this.config.version}`);
      },
    });

    // Status command
    commands.push({
      name: 'status',
      description: 'Show system status',
      handler: async (_args, _options) => {
        console.log('System Status:');
        console.log(`- CLI: ${this.config.name} v${this.config.version}`);
        console.log(
          `- Database: ${this.context.db ? 'Connected' : 'Not connected'}`,
        );
        console.log(`- AI: ${this.context.ai ? 'Available' : 'Not available'}`);
        console.log(`- User: ${this.context.user?.id || 'Not authenticated'}`);
      },
    });

    return commands;
  }

  /**
   * Create schema command handler
   */
  private createSchemaHandler(): (args: any, options: any) => Promise<void> {
    return async (args: any, _options: any) => {
      const objectName = args[0];
      const fields = ObjectRegistry.getFields(objectName);
      if (fields.size === 0) {
        this.exitWithError(`Object ${objectName} not found`);
        return;
      }

      console.log(`Schema for ${objectName}:`);
      for (const [fieldName, field] of fields) {
        console.log(
          `  ${fieldName}: ${field.type}${field.options?.required ? ' (required)' : ''}`,
        );
        if (field.options?.description) {
          console.log(`    ${field.options.description}`);
        }
      }
    };
  }

  /**
   * Show help information
   */
  async showHelp(commands: CLICommand[]): Promise<void> {
    console.log(`${this.config.name} v${this.config.version}`);
    console.log(this.config.description);
    console.log();

    // Show built-in subcommands first
    const [
      gnodeCommands,
      generateCommands,
      gitCommands,
      initCommands,
      utilityCommands,
      dispatchCommands,
      docsCommands,
      playgroundCommands,
    ] = await Promise.all([
      getGnodeCommands(),
      getGenerateCommands(),
      getGitCommands(),
      getInitCommands(),
      getUtilityCommands(),
      getDispatchCommands(),
      getDocsCommands(),
      getPlaygroundCommands(),
    ]);

    console.log('Project Setup:');
    for (const command of Object.values(initCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    console.log('Playground:');
    for (const command of Object.values(playgroundCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    console.log('Utility Commands:');
    for (const command of Object.values(utilityCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    console.log('Dispatch (Inter-Agent Communication):');
    for (const command of Object.values(dispatchCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    console.log('Git Integration:');
    for (const command of Object.values(gitCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    console.log('Gnode Commands:');
    for (const command of Object.values(gnodeCommands)) {
      this.showCommandHelp(command);
    }

    console.log('Code Generation:');
    for (const command of Object.values(generateCommands)) {
      this.showCommandHelp(command);
    }

    console.log('Documentation:');
    for (const command of Object.values(docsCommands)) {
      this.showCommandHelp(command);
    }
    console.log();

    // Show utility commands (from object commands list)
    const builtInUtilityCommands = commands.filter(
      (cmd) =>
        cmd.name === 'objects' ||
        cmd.name === 'schema' ||
        cmd.name === 'help' ||
        cmd.name === 'version' ||
        cmd.name === 'status',
    );

    if (builtInUtilityCommands.length > 0) {
      console.log('Object Utilities:');
      for (const command of builtInUtilityCommands) {
        this.showCommandHelp(command);
      }
    }

    // Show auto-generated object commands
    const objectCommands = commands.filter(
      (cmd) => !builtInUtilityCommands.includes(cmd),
    );

    if (objectCommands.length > 0) {
      console.log('Object Commands (auto-generated):');
      for (const command of objectCommands) {
        this.showCommandHelp(command);
      }
    }
  }

  /**
   * Show help for a single command
   */
  private showCommandHelp(command: CLICommand): void {
    const aliases = command.aliases ? ` (${command.aliases.join(', ')})` : '';
    const args = command.args
      ? ` ${command.args.map((arg) => `<${arg}>`).join(' ')}`
      : '';
    console.log(`  ${command.name}${args}${aliases}`);
    console.log(`    ${command.description}`);

    if (command.options) {
      for (const [name, option] of Object.entries(command.options)) {
        const short = option.short ? `-${option.short}, ` : '';
        console.log(`    ${short}--${name}: ${option.description}`);
      }
    }
    console.log();
  }

  /**
   * Create a simple spinner
   */
  private createSpinner(text: string): {
    succeed: (text?: string) => void;
    fail: (text?: string) => void;
  } {
    // Check if TTY is available AND clearLine/cursorTo methods exist
    const isTTY =
      process.stdout.isTTY &&
      typeof process.stdout.clearLine === 'function' &&
      typeof process.stdout.cursorTo === 'function';

    if (this.config.colors && isTTY) {
      process.stdout.write(`⠋ ${text}`);
      return {
        succeed: (successText?: string) => {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          console.log(`✅ ${successText || text}`);
        },
        fail: (errorText?: string) => {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          console.log(`❌ ${errorText || text}`);
        },
      };
    }
    // Non-TTY fallback: simple console.log
    console.log(text);
    return {
      succeed: (successText?: string) => console.log(successText || 'Done'),
      fail: (errorText?: string) => console.log(errorText || 'Failed'),
    };
  }

  /**
   * Prompt for input
   */
  private async prompt(message: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`${message} `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  /**
   * Confirm prompt
   */
  private async confirm(message: string): Promise<boolean> {
    const answer = await this.prompt(`${message} (y/n)`);
    return answer.toLowerCase().startsWith('y');
  }

  /**
   * Handle LIST command
   */
  private async handleList(objectName: string, options: any): Promise<void> {
    const spinner = this.createSpinner(`Listing ${objectName} objects...`);

    try {
      const collection = await this.getCollection(objectName);

      const listOptions: any = {
        limit: Number.parseInt(options.limit, 10),
        offset: Number.parseInt(options.offset, 10),
      };

      if (options.orderBy) {
        listOptions.orderBy = options.orderBy;
      }

      if (options.where) {
        listOptions.where = JSON.parse(options.where);
      }

      const results = await collection.list(listOptions);

      spinner.succeed(`Found ${results.length} ${objectName} objects`);

      if (options.format === 'json') {
        console.log(JSON.stringify(results, null, 2));
      } else {
        this.displayTable(results, objectName);
      }
    } catch (error) {
      spinner.fail(`Failed to list ${objectName} objects`);
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Handle GET command
   */
  private async handleGet(
    objectName: string,
    id: string,
    options: any,
  ): Promise<void> {
    const spinner = this.createSpinner(`Getting ${objectName}...`);

    try {
      const collection = await this.getCollection(objectName);
      const result = await collection.get(id);

      if (!result) {
        spinner.fail(`${objectName} not found`);
        this.exitWithError(`${objectName} not found`);
        return;
      }

      spinner.succeed(`Found ${objectName}`);

      if (options.format === 'yaml') {
        // Simple YAML-like output
        console.log(this.toYamlString(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      spinner.fail(`Failed to get ${objectName}`);
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Mass-assignment guard for generated CLI create/update (#1540, #1390
   * round 5 codex HIGH#3). Mirrors the REST/MCP `applyWritablePolicy`
   * (`packages/core/src/generators/rest.ts`): strip framework/server-managed
   * and `@field({ readonly: true })` fields from a create/update payload, and —
   * when an `@smrt({ api: { writable: [...] } })` allowlist is set — intersect
   * with it. Without this the generated CLI accepted every field for
   * create/update (a framework-wide CLI-shaped hole in the #1540 protection),
   * so e.g. `Payment.status` (excluded from `api.writable`) could be set from
   * the CLI. Models without a writable allowlist keep their prior behavior
   * minus framework fields, consistent with REST.
   */
  private applyWritablePolicy(
    objectName: string | undefined,
    data: any,
  ): Record<string, any> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const serverManaged = new Set([
      'id',
      'tenantId',
      'tenant_id',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);

    const readonly = new Set<string>();
    let writable: string[] | null = null;

    if (objectName) {
      const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
      if (
        apiConfig &&
        typeof apiConfig === 'object' &&
        Array.isArray((apiConfig as { writable?: unknown }).writable)
      ) {
        writable = (apiConfig as { writable: string[] }).writable;
      }

      for (const [name, def] of ObjectRegistry.getFields(objectName)) {
        if (
          def &&
          ((def as any).readonly === true ||
            (def as any)._meta?.readonly === true)
        ) {
          readonly.add(name);
        }
      }
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (serverManaged.has(key)) continue;
      if (readonly.has(key)) continue;
      if (writable && !writable.includes(key)) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Handle CREATE command
   */
  private async handleCreate(objectName: string, options: any): Promise<void> {
    try {
      let data: any = {};

      // `parseCliArgs` preserves the registered (kebab-case) option key
      // (`from-file`), but earlier code read only the camelCase `fromFile`, so
      // the `--from-file` create path never fired — the file was never read and
      // (worse) its input never reached `applyWritablePolicy` (round 5's
      // mass-assignment guard was a no-op on this path). Resolve both spellings
      // so `--from-file` input is loaded AND policed (#1390 round 6, codex MED).
      const fromFile = options.fromFile ?? options['from-file'];

      if (fromFile) {
        // Load from file
        const fs = await import('node:fs/promises');
        const content = await fs.readFile(fromFile, 'utf-8');
        data = JSON.parse(content);
      } else if (options.interactive && this.config.prompt) {
        // Interactive mode
        data = await this.promptForFields(objectName, {});
      } else {
        // From command line options
        const fields = ObjectRegistry.getFields(objectName);
        for (const [fieldName] of fields) {
          const optionName = fieldName.replace(/_/g, '-');
          if (options[optionName] !== undefined) {
            data[fieldName] = this.parseFieldValue(options[optionName]);
          }
        }
      }

      // Enforce the writable allowlist + framework-field strip on EVERY input
      // path (file / interactive / options), matching REST/MCP (#1540).
      data = this.applyWritablePolicy(objectName, data);

      const spinner = this.createSpinner(`Creating ${objectName}...`);

      const collection = await this.getCollection(objectName);
      const result = await collection.create(data);
      await result.save();

      spinner.succeed(`Created ${objectName} with ID: ${result.id}`);

      if (!options.quiet) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Handle UPDATE command
   */
  private async handleUpdate(
    objectName: string,
    id: string,
    options: any,
  ): Promise<void> {
    try {
      const collection = await this.getCollection(objectName);
      const existing = await collection.get(id);

      if (!existing) {
        this.exitWithError(`${objectName} not found`);
        return;
      }

      let data: any = {};

      // See handleCreate: `parseCliArgs` keeps the kebab-case `from-file` key,
      // so resolve both spellings — otherwise `--from-file` updates silently
      // skip the file AND the writable policy (#1390 round 6, codex MED).
      const fromFile = options.fromFile ?? options['from-file'];

      if (fromFile) {
        // Load from file
        const fs = await import('node:fs/promises');
        const content = await fs.readFile(fromFile, 'utf-8');
        data = JSON.parse(content);
      } else if (options.interactive && this.config.prompt) {
        // Interactive mode with current values
        data = await this.promptForFields(objectName, existing);
      } else {
        // From command line options
        const fields = ObjectRegistry.getFields(objectName);
        for (const [fieldName] of fields) {
          const optionName = fieldName.replace(/_/g, '-');
          if (options[optionName] !== undefined) {
            data[fieldName] = this.parseFieldValue(options[optionName]);
          }
        }
      }

      // Enforce the writable allowlist + framework-field strip on EVERY input
      // path (file / interactive / options), matching REST/MCP (#1540).
      data = this.applyWritablePolicy(objectName, data);

      const spinner = this.createSpinner(`Updating ${objectName}...`);

      Object.assign(existing, data);
      await existing.save();

      spinner.succeed(`Updated ${objectName}`);

      if (!options.quiet) {
        console.log(JSON.stringify(existing, null, 2));
      }
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Handle DELETE command
   */
  private async handleDelete(
    objectName: string,
    id: string,
    options: any,
  ): Promise<void> {
    try {
      const collection = await this.getCollection(objectName);
      const existing = await collection.get(id);

      if (!existing) {
        this.exitWithError(`${objectName} not found`);
        return;
      }

      // Confirmation prompt
      if (!options.force && this.config.prompt) {
        const confirmed = await this.confirm(
          `Are you sure you want to delete ${objectName} "${(existing as any).name || existing.slug || existing.id}"?`,
        );
        if (!confirmed) {
          console.log('Cancelled');
          return;
        }
      }

      const spinner = this.createSpinner(`Deleting ${objectName}...`);

      await existing.delete();

      spinner.succeed(`Deleted ${objectName}`);
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Handle custom method execution
   */
  private async handleCustomMethod(
    objectName: string,
    id: string,
    methodName: string,
    options: any,
  ): Promise<void> {
    try {
      const collection = await this.getCollection(objectName);
      const obj = await collection.get(id);

      if (!obj) {
        this.exitWithError(`${objectName} not found`);
        return;
      }

      // Get method metadata for parameter mapping (including inherited methods)
      const methods = await ObjectRegistry.getAllMethods(objectName);
      const methodDef = methods.get(methodName);

      if (!methodDef) {
        this.exitWithError(`Method ${methodName} not found on ${objectName}`);
        return;
      }

      // In JSON mode, suppress spinner and other non-JSON output
      const jsonMode = options.json === true;
      const spinner = jsonMode
        ? {
            succeed: (_text?: string) => {},
            fail: (msg?: string) => {
              if (msg) {
                console.error(msg);
              }
            },
          }
        : this.createSpinner(`Executing ${methodName} on ${objectName}...`);

      // Map CLI options to method parameters (kebab-case to camelCase)
      // Handle both flat parameters and object type parameters (fix for issue #620)
      const methodParams = methodDef.parameters || [];
      const methodCallArgs: any[] = [];

      for (const param of methodParams) {
        const typeStr = param.type || '';
        const isObjectType = this.isObjectTypeParameter(typeStr);

        if (isObjectType) {
          // Object type parameter - reconstruct from individual CLI options
          const objArg: any = {};
          // Extract property definitions from type string
          const match = typeStr.match(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
          if (match) {
            const propsStr = match[1];
            const propMatches = propsStr.matchAll(/(\w+)(\?)?:\s*([^;]+)/g);
            for (const propMatch of propMatches) {
              const [, propName] = propMatch;
              // Convert camelCase to kebab-case for CLI option lookup
              const optionName = propName
                .replace(/([A-Z])/g, '-$1')
                .toLowerCase();
              if (options[optionName] !== undefined) {
                // Auto-parse JSON objects and arrays from CLI strings
                let value = options[optionName];
                if (
                  typeof value === 'string' &&
                  (value.startsWith('{') || value.startsWith('['))
                ) {
                  try {
                    value = JSON.parse(value);
                  } catch {
                    // Keep as string if JSON parsing fails
                  }
                }
                objArg[propName] = value;
              }
            }
          }
          // Always push something to maintain parameter positions
          if (Object.keys(objArg).length > 0) {
            methodCallArgs.push(objArg);
          } else if (!param.optional) {
            methodCallArgs.push({});
          } else {
            methodCallArgs.push(undefined);
          }
        } else {
          // Flat parameter - get from CLI option
          const optionName = param.name
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase();
          if (options[optionName] !== undefined) {
            methodCallArgs.push(options[optionName]);
          } else if (param.default !== undefined) {
            methodCallArgs.push(param.default);
          } else {
            methodCallArgs.push(undefined);
          }
        }
      }

      // Call the method on the object instance
      const method = (obj as any)[methodName];
      if (typeof method !== 'function') {
        spinner.fail(`Method ${methodName} is not a function`);
        this.exitWithError(`Method ${methodName} is not callable`);
        return;
      }

      const result = await method.call(obj, ...methodCallArgs);

      spinner.succeed(`Executed ${methodName}`);

      // Output result in JSON format
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  /**
   * Handle singleton method (no parameters, no database lookup)
   * Creates a new instance with proper config and calls the method
   */
  private async handleSingletonMethod(
    objectName: string,
    methodName: string,
    options: any,
    methodDef?: {
      parameters?: Array<{
        name: string;
        type?: string;
        optional?: boolean;
        default?: any;
      }>;
    },
  ): Promise<void> {
    try {
      const classInfo = ObjectRegistry.getClass(objectName);
      if (!classInfo || !classInfo.constructor) {
        const availableObjects = Array.from(
          ObjectRegistry.getAllClasses().values(),
        ).map((info) => info.name);
        const availableList =
          availableObjects.length > 0
            ? `Available objects:\n  ${availableObjects.join('\n  ')}`
            : 'No objects registered. Run "npm run build" to generate registrations.';

        this.exitWithError(
          `Object class '${objectName}' not found.\n\n` +
            `${availableList}\n\n` +
            `Troubleshooting:\n` +
            `1. Run "npm run build" to generate .smrt/register.js\n` +
            `2. Ensure package exports classes correctly\n` +
            `3. Run "smrt doctor" for diagnostics`,
        );
        return;
      }

      // In JSON mode, suppress spinner and other non-JSON output
      const jsonMode = options.json === true;
      const spinner = jsonMode
        ? {
            succeed: (_text?: string) => {},
            fail: (msg?: string) => {
              if (msg) {
                console.error(msg);
              }
            },
          }
        : this.createSpinner(`Executing ${methodName} on ${objectName}...`);

      // Load full application config from smrt.config.js
      const { getConfig, getPackageConfig, getModuleConfig } = await import(
        '@happyvertical/smrt-config'
      );
      const smrtConfig = getConfig() || {};
      // Get module-specific config (e.g., modules.praeco for Praeco class)
      const moduleConfig = getModuleConfig(objectName.toLowerCase(), {}) as {
        db?: any;
      };

      // Get database config and create connection
      const { DEFAULT_CLI_CONFIG } = await import('./config.js');
      const cliConfig = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      // Initialize database connection from config
      let db = this.context.db;
      if (!db && cliConfig?.database?.url) {
        const { getDatabase } = await import('@happyvertical/sql');
        db = await getDatabase({
          type: cliConfig.database.type || 'sqlite',
          url: cliConfig.database.url,
        });
      }

      // Check if we have a real constructor (not just a manifest stub)
      const isManifestStub =
        (classInfo.constructor as any)?._isManifestStub === true;

      if (process.env.DEBUG) {
        console.log(`[DEBUG] ${objectName} constructor info:`);
        console.log(`  - isManifestStub: ${isManifestStub}`);
        console.log(
          `  - constructor name: ${classInfo.constructor?.name || 'undefined'}`,
        );
        console.log(`  - packageName: ${classInfo.packageName || 'local'}`);
      }

      if (isManifestStub) {
        this.exitWithError(
          `${objectName} is registered from manifest but the real class wasn't loaded.\n\n` +
            `This usually means:\n` +
            `1. The .smrt/register.js file doesn't import the class\n` +
            `2. The package doesn't export the class properly\n` +
            `3. The class name in the package doesn't match the manifest\n\n` +
            `Try:\n` +
            `- Run 'npm run build' to regenerate .smrt/register.js\n` +
            `- Check that the package exports the ${objectName} class\n` +
            `- Check .smrt/register.js imports match the package exports`,
        );
        return;
      }

      // Verify constructor is callable
      if (typeof classInfo.constructor !== 'function') {
        this.exitWithError(
          `${objectName} constructor is not available.\n` +
            `This usually means the class wasn't properly exported or registered.\n` +
            `Check that the package exports the class and .smrt/register.js imports it.`,
        );
        return;
      }

      // Create instance with config
      // Order: global config, then module-specific config, then CLI overrides
      // Note: CLI db connection only used if module doesn't have its own db config
      const useCliDb = db && !moduleConfig?.db;
      const instanceConfig = {
        ...smrtConfig,
        ...moduleConfig,
        ...(useCliDb && { db }),
        ...(this.context.ai && { ai: this.context.ai }),
        // In JSON mode, silence all log output to ensure clean JSON
        ...(jsonMode && { silent: true }),
      };

      const obj = new classInfo.constructor(instanceConfig);

      // Initialize (required for objects that set up sub-collections, AI clients, etc.)
      if (typeof obj.initialize === 'function') {
        await obj.initialize();
      }

      // Call the method
      const method = (obj as any)[methodName];
      if (typeof method !== 'function') {
        spinner.fail(`Method ${methodName} is not a function`);
        this.exitWithError(`Method ${methodName} is not callable`);
        return;
      }

      // Map CLI options to method parameters (kebab-case to camelCase)
      // Handle both flat parameters and object type parameters
      const methodParams = methodDef?.parameters || [];
      const methodCallArgs: any[] = [];

      for (const param of methodParams) {
        const typeStr = param.type || '';
        const isObjectType = this.isObjectTypeParameter(typeStr);

        if (isObjectType) {
          // Object type parameter - reconstruct from individual CLI options
          const objArg: any = {};
          // Extract property definitions from type string
          const match = typeStr.match(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
          if (match) {
            const propsStr = match[1];
            const propMatches = propsStr.matchAll(/(\w+)(\?)?:\s*([^;]+)/g);
            for (const propMatch of propMatches) {
              const [, propName] = propMatch;
              // Convert camelCase to kebab-case for CLI option lookup
              const optionName = propName
                .replace(/([A-Z])/g, '-$1')
                .toLowerCase();
              if (options[optionName] !== undefined) {
                // Auto-parse JSON objects and arrays from CLI strings
                // Note: Only values starting with { or [ are parsed as JSON
                let value = options[optionName];
                if (
                  typeof value === 'string' &&
                  (value.startsWith('{') || value.startsWith('['))
                ) {
                  try {
                    value = JSON.parse(value);
                  } catch {
                    // Keep as string if JSON parsing fails
                  }
                }
                objArg[propName] = value;
              }
            }
          }
          // Always push something to maintain parameter positions
          if (Object.keys(objArg).length > 0) {
            methodCallArgs.push(objArg);
          } else if (!param.optional) {
            methodCallArgs.push({});
          } else {
            methodCallArgs.push(undefined);
          }
        } else {
          // Flat parameter - get from CLI option
          const optionName = param.name
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase();
          if (options[optionName] !== undefined) {
            methodCallArgs.push(options[optionName]);
          } else if (param.default !== undefined) {
            methodCallArgs.push(param.default);
          } else {
            // Always push undefined to maintain parameter positions
            methodCallArgs.push(undefined);
          }
        }
      }

      const result = await method.call(obj, ...methodCallArgs);

      spinner.succeed(`Executed ${methodName}`);

      // Output result in JSON format
      if (result !== undefined) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      // Provide detailed error context for debugging
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      console.error(`\nError executing ${objectName}.${methodName}():`);
      console.error(`  ${errorMessage}`);
      if (errorStack && process.env.DEBUG) {
        console.error('\nStack trace:');
        console.error(errorStack);
      }
      const schemaGuidance = errorMessage.includes("Run 'smrt db:migrate'");
      console.error(
        schemaGuidance
          ? '\nTip: Prepare the database schema before running generated CLI commands.'
          : '\nTip: Set DEBUG=1 for full stack trace, or check the method implementation.',
      );

      this.exitWithError(errorMessage);
    }
  }

  /**
   * Get or create collection for an object
   * Uses database configuration from smrt.config.js or defaults to :memory:
   */
  private async getCollection(
    objectName: string,
  ): Promise<SmrtCollection<any>> {
    if (!this.collections.has(objectName)) {
      const classInfo = ObjectRegistry.getClass(objectName);
      if (!classInfo || !classInfo.collectionConstructor) {
        // Enhanced error message with troubleshooting
        const availableObjects = Array.from(
          ObjectRegistry.getAllClasses().values(),
        ).map((info) => info.name);

        throw new Error(
          `Object '${objectName}' not found or has no collection constructor.\n\n` +
            `Available objects:\n  ${availableObjects.join('\n  ')}\n\n` +
            `Troubleshooting:\n` +
            `1. If from external package, ensure it's installed:\n` +
            `   npm install <package-name>\n\n` +
            `2. Rebuild your project to regenerate manifest:\n` +
            `   npm run build\n\n` +
            `3. Check .smrt/manifest.json contains the object\n\n` +
            `4. Verify package exports classes correctly\n` +
            `5. Run with verbose mode for more details:\n` +
            `   SMRT_CLI_VERBOSE=true npx smrt ${objectName}:list\n`,
        );
      }

      // Get database from context or config
      let db = this.context.db;
      if (!db) {
        const { getPackageConfig } = await import('@happyvertical/smrt-config');
        const { DEFAULT_CLI_CONFIG } = await import('./config.js');
        const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

        // Initialize database connection from config
        const { getDatabase } = await import('@happyvertical/sql');
        db = await getDatabase({
          type: config.database.type,
          url: config.database.url,
        });

        if (config.verbose) {
          console.log(`[CLI] Using database: ${config.database.url}`);
        }
      }

      const collection = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db,
      });

      await collection.initialize();
      this.collections.set(objectName, collection);
    }
    const collection = this.collections.get(objectName);
    if (!collection) throw new Error(`Collection ${objectName} not found`);
    return collection;
  }

  /**
   * Interactive field prompts
   */
  private async promptForFields(
    objectName: string,
    current: any,
  ): Promise<any> {
    const fields = ObjectRegistry.getFields(objectName);
    const result: any = {};

    for (const [fieldName, field] of fields) {
      const currentValue = current[fieldName];
      let message = `${fieldName}`;
      if (field.options?.description) {
        message += ` (${field.options.description})`;
      }
      if (currentValue !== undefined) {
        message += ` [${currentValue}]`;
      }
      message += ': ';

      if (field.type === 'boolean') {
        result[fieldName] = await this.confirm(message);
      } else {
        const input = await this.prompt(message);
        if (input.trim()) {
          result[fieldName] = this.parseFieldValue(input);
        } else if (currentValue !== undefined) {
          result[fieldName] = currentValue;
        }
      }
    }

    return result;
  }

  /**
   * Parse field value from string
   */
  private parseFieldValue(value: string): any {
    // Try to parse as JSON first
    try {
      return JSON.parse(value);
    } catch {
      // Return as string
      return value;
    }
  }

  /**
   * Display results as table
   */
  private displayTable(results: any[], objectName: string): void {
    if (results.length === 0) {
      console.log(`No ${objectName} objects found`);
      return;
    }

    // Simple table display
    const keys = ['id', 'name', 'slug', 'created_at'];
    const rows = results.map((item) =>
      keys.map((key) => String(item[key] || '').substring(0, 30)),
    );

    console.log();
    console.log(keys.join('\t'));
    console.log('-'.repeat(80));
    rows.forEach((row) => {
      console.log(row.join('\t'));
    });
    console.log();
  }

  /**
   * Convert object to YAML-like string
   */
  private toYamlString(obj: any, indent = 0): string {
    const spaces = '  '.repeat(indent);
    let result = '';

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        result += `${spaces}${key}: null\n`;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        result += `${spaces}${key}:\n${this.toYamlString(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        result += `${spaces}${key}:\n`;
        value.forEach((item) => {
          result += `${spaces}  - ${item}\n`;
        });
      } else {
        result += `${spaces}${key}: ${value}\n`;
      }
    }

    return result;
  }
}

// CLI Binary Entry Point
export async function main() {
  const args = process.argv.slice(2);
  const timingEnabled = args.includes('--timing');
  const timing: Record<string, number> = {};

  const startTime = timingEnabled ? performance.now() : 0;

  // Load .env from the project directory (where smrt.config.js lives)
  // before loading config, since config may reference process.env
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const configNames = [
      'smrt.config.js',
      'smrt.config.mjs',
      'smrt.config.cjs',
      'smrt.config.json',
    ];
    let dir = process.cwd();
    const { root } = path.parse(dir);
    while (dir !== root) {
      if (configNames.some((name) => fs.existsSync(path.join(dir, name)))) {
        try {
          const { loadEnvFile } = await import('node:process');
          loadEnvFile(path.join(dir, '.env'));
        } catch {
          // .env doesn't exist or Node < 20.12, continue without it
        }
        break;
      }
      dir = path.dirname(dir);
    }
  }

  // Initialize smrt-config (loads smrt.config.js if present)
  const configStart = timingEnabled ? performance.now() : 0;
  const { loadConfig } = await import('@happyvertical/smrt-config');
  await loadConfig({ cache: true });
  if (timingEnabled) {
    timing.config = performance.now() - configStart;
  }

  const config: CLIConfig = {
    name: 'smrt',
    version: CLI_VERSION,
    description: 'Admin CLI for smrt objects',
    prompt: !process.env.CI, // Disable prompts in CI
    colors: !process.env.NO_COLOR && process.stdout.isTTY,
  };

  const context: CLIContext = {
    // db and ai can be configured via environment or initialized here
    timing: timingEnabled ? timing : undefined,
  };

  const cli = new CLIGenerator(config, context);
  const handler = cli.generateHandler();

  // Remove --timing from args before passing to handler
  const filteredArgs = args.filter((arg) => arg !== '--timing');

  try {
    await handler(filteredArgs);
  } catch (error) {
    console.error(
      'CLI Error:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exit(1);
  }

  // Print timing summary if enabled
  if (timingEnabled) {
    timing.total = performance.now() - startTime;
    console.log('\n⏱  Startup Timing:');
    console.log(`   Config load:      ${timing.config?.toFixed(0) ?? 'N/A'}ms`);
    console.log(
      `   Class loading:    ${timing.classLoading?.toFixed(0) ?? 'N/A'}ms`,
    );
    console.log(
      `   Command gen:      ${timing.commandGen?.toFixed(0) ?? 'N/A'}ms`,
    );
    console.log(`   Total startup:    ${timing.total.toFixed(0)}ms`);
  }
}

// NOTE: Do not add self-execution check here.
// The entry point (src/index.ts) calls main() directly.
// Adding a self-execution check would cause double execution when bundled.
