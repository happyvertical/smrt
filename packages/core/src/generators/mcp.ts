/**
 * MCP (Model Context Protocol) server generator for smrt objects
 *
 * Exposes smrt objects as AI tools for Claude, GPT, and other AI models
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SmrtCollection } from '../collection';
import type { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import {
  generateClaudeConfig,
  generateMCPDocumentation,
  generateMCPScript,
  generateRuntimeBootstrap,
  type RuntimeOptions,
} from './mcp-runtime-template.js';

export interface MCPConfig {
  name?: string;
  version?: string;
  description?: string;
  server?: {
    name: string;
    version: string;
  };
}

export interface MCPContext {
  db?: any;
  ai?: any;
  user?: {
    id: string;
    roles?: string[];
  };
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPRequest {
  method: string;
  params: {
    name: string;
    arguments: Record<string, any>;
  };
}

export interface MCPResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

/**
 * Generate MCP server from smrt objects
 */
export class MCPGenerator {
  private config: MCPConfig;
  private context: MCPContext;
  private collections = new Map<string, SmrtCollection<any>>();

  constructor(config: MCPConfig = {}, context: MCPContext = {}) {
    this.config = {
      name: 'smrt-mcp-server',
      version: '1.0.0',
      description: 'Auto-generated MCP server from smrt objects',
      server: {
        name: 'smrt-mcp',
        version: '1.0.0',
      },
      ...config,
    };
    this.context = context;
  }

  /**
   * Get server name
   */
  get name(): string | undefined {
    return this.config.name;
  }

  /**
   * Get server version
   */
  get version(): string | undefined {
    return this.config.version;
  }

  /**
   * Generate all available tools from registered objects
   */
  async generateTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const registeredClasses = ObjectRegistry.getAllClasses();

    for (const [key, classInfo] of registeredClasses) {
      // Issue #951: Use simple name for tool naming, map key for registry lookups
      const simpleName = classInfo.name || key;
      const config = ObjectRegistry.getConfig(simpleName);
      const mcpConfig = config.mcp;

      // Handle boolean vs object config
      const excluded: string[] =
        typeof mcpConfig === 'object' && mcpConfig?.exclude
          ? mcpConfig.exclude
          : [];
      const included: string[] | undefined =
        typeof mcpConfig === 'object' ? mcpConfig?.include : undefined;

      const shouldInclude = (endpoint: string) => {
        if (included && !included.includes(endpoint)) return false;
        if (excluded.includes(endpoint)) return false;
        return true;
      };

      const objectTools = await this.generateObjectTools(
        simpleName,
        shouldInclude,
      );
      tools.push(...objectTools);
    }

    return tools;
  }

  /**
   * Generate tools for a specific object
   */
  private async generateObjectTools(
    objectName: string,
    shouldInclude: (endpoint: string) => boolean,
  ): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const fields = ObjectRegistry.getFields(objectName);
    const lowerName = objectName.toLowerCase();
    const classInfo = ObjectRegistry.getClass(objectName);

    // LIST tool
    if (shouldInclude('list')) {
      tools.push({
        name: `${lowerName}_list`,
        description: `List ${objectName} objects with optional filtering`,
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              description: 'Maximum number of items to return',
              default: 50,
              minimum: 1,
              maximum: 1000,
            },
            offset: {
              type: 'integer',
              description: 'Number of items to skip',
              default: 0,
              minimum: 0,
            },
            orderBy: {
              type: 'string',
              description: 'Field to order by (e.g., "created_at DESC")',
            },
            where: {
              type: 'object',
              description: 'Filter conditions as key-value pairs',
              additionalProperties: true,
            },
          },
        },
      });
    }

    // GET tool
    if (shouldInclude('get')) {
      tools.push({
        name: `${lowerName}_get`,
        description: `Get a specific ${objectName} by ID or slug`,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier of the object',
            },
            slug: {
              type: 'string',
              description: 'URL-friendly identifier of the object',
            },
          },
          required: ['id'],
        },
      });
    }

    // CREATE tool
    if (shouldInclude('create')) {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const [fieldName, field] of fields) {
        properties[fieldName] = this.fieldToMCPSchema(field);
        if (field._meta?.required) {
          required.push(fieldName);
        }
      }

      tools.push({
        name: `${lowerName}_create`,
        description: `Create a new ${objectName}`,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
      });
    }

    // UPDATE tool
    if (shouldInclude('update')) {
      const properties: Record<string, any> = {
        id: {
          type: 'string',
          description: 'ID of the object to update',
        },
      };

      for (const [fieldName, field] of fields) {
        properties[fieldName] = this.fieldToMCPSchema(field);
      }

      tools.push({
        name: `${lowerName}_update`,
        description: `Update an existing ${objectName}`,
        inputSchema: {
          type: 'object',
          properties,
          required: ['id'],
        },
      });
    }

    // DELETE tool
    if (shouldInclude('delete')) {
      tools.push({
        name: `${lowerName}_delete`,
        description: `Delete a ${objectName} by ID`,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID of the object to delete',
            },
          },
          required: ['id'],
        },
      });
    }

    // CUSTOM METHODS - discover from manifest and show by default
    if (classInfo) {
      const config = ObjectRegistry.getConfig(objectName);
      const mcpConfig = config.mcp;
      const included: string[] | undefined =
        typeof mcpConfig === 'object' ? mcpConfig?.include : undefined;
      const excluded: string[] =
        typeof mcpConfig === 'object' && mcpConfig?.exclude
          ? mcpConfig.exclude
          : [];

      // Check if include list contains any custom method names (indicates strict mode)
      const crudOperations = ['list', 'get', 'create', 'update', 'delete'];
      const customMethodsInInclude =
        included?.filter((item) => !crudOperations.includes(item)) || [];
      const hasCustomMethodsInInclude = customMethodsInInclude.length > 0;

      // Try to discover methods from manifest (including inherited methods)
      const methods = await ObjectRegistry.getAllMethods(objectName);
      const methodNames = new Set(Array.from(methods.keys()));

      // If we have an include list with custom methods, validate and generate tools
      if (hasCustomMethodsInInclude) {
        for (const methodName of customMethodsInInclude) {
          // Skip if explicitly excluded
          if (excluded.includes(methodName)) continue;

          // Check if method exists (in manifest or on class prototype)
          const existsInManifest = methodNames.has(methodName);
          const existsOnClass = this.validateCustomMethod(
            classInfo.constructor,
            methodName,
          );

          if (!existsInManifest && !existsOnClass) {
            // Warn about missing methods
            console.warn(
              `Warning: Custom action '${methodName}' specified in MCP config for ${objectName}, but method ${methodName}() not found on class`,
            );
            continue;
          }

          // Generate tool for this method
          const toolName = `${lowerName}_${methodName}`.toLowerCase();
          tools.push({
            name: toolName,
            description: `Execute ${methodName} action on ${objectName}`,
            inputSchema: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'ID of the object to execute action on',
                },
                options: {
                  type: 'object',
                  description: 'Additional options for the custom action',
                  additionalProperties: true,
                },
              },
              required: ['id'],
            },
          });
        }
      } else {
        // No custom methods in include = show all discovered methods by default
        for (const [methodName, methodDef] of methods) {
          // Skip if not public (private/protected methods shouldn't be in MCP)
          if (!methodDef.isPublic) continue;

          // Always respect exclude list
          if (excluded.includes(methodName)) continue;

          // Generate MCP tool for this custom method
          const toolName = `${lowerName}_${methodName}`.toLowerCase();
          tools.push({
            name: toolName,
            description: `Execute ${methodName} action on ${objectName}`,
            inputSchema: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'ID of the object to execute action on',
                },
                options: {
                  type: 'object',
                  description: 'Additional options for the custom action',
                  additionalProperties: true,
                },
              },
              required: ['id'],
            },
          });
        }
      }
    }

    return tools;
  }

  /**
   * Validate that a custom method exists on a class
   */
  private validateCustomMethod(
    classConstructor: typeof SmrtObject,
    methodName: string,
  ): boolean {
    try {
      // Check if method exists on the prototype
      const prototype = classConstructor.prototype;

      // Check if the method exists and is a function
      if (typeof (prototype as any)[methodName] === 'function') {
        return true;
      }

      // Also check static methods
      if (typeof (classConstructor as any)[methodName] === 'function') {
        return true;
      }

      return false;
    } catch (error) {
      console.warn(
        `Error validating method ${methodName} on class ${classConstructor.name}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Convert field definition to MCP schema
   */
  private fieldToMCPSchema(field: any): any {
    const schema: any = {
      description: field._meta?.description || `${field.type} field`,
    };

    switch (field.type) {
      case 'text':
        schema.type = 'string';
        if (field._meta?.maxLength) schema.maxLength = field._meta.maxLength;
        if (field._meta?.minLength) schema.minLength = field._meta.minLength;
        break;
      case 'integer':
        schema.type = 'integer';
        if (field._meta?.min !== undefined) schema.minimum = field._meta.min;
        if (field._meta?.max !== undefined) schema.maximum = field._meta.max;
        break;
      case 'decimal':
        schema.type = 'number';
        if (field._meta?.min !== undefined) schema.minimum = field._meta.min;
        if (field._meta?.max !== undefined) schema.maximum = field._meta.max;
        break;
      case 'boolean':
        schema.type = 'boolean';
        break;
      case 'datetime':
        schema.type = 'string';
        schema.format = 'date-time';
        break;
      case 'json':
        schema.type = 'object';
        break;
      case 'foreignKey':
        schema.type = 'string';
        schema.description = `ID of related ${field.related || 'object'}`;
        break;
      default:
        schema.type = 'string';
    }

    if (field._meta?.default !== undefined) {
      schema.default = field._meta.default;
    }

    return schema;
  }

  /**
   * Handle MCP tool calls
   */
  async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      // Check if tool exists
      const availableTools = await this.generateTools();
      const toolExists = availableTools.some((t) => t.name === name);

      if (!toolExists) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Parse tool name: objectname_action
      const [objectName, action] = name.split('_');

      if (!objectName || !action) {
        throw new Error(`Invalid tool name format: ${name}`);
      }

      // Find the registered class (case-insensitive)
      const registeredClasses = ObjectRegistry.getAllClasses();
      let classInfo = null;
      let actualObjectName = '';

      for (const [_key, info] of registeredClasses) {
        // Issue #951: Match by simple name, not the qualified map key
        const simpleName = info.name || _key;
        if (simpleName.toLowerCase() === objectName.toLowerCase()) {
          classInfo = info;
          actualObjectName = simpleName;
          break;
        }
      }

      if (!classInfo) {
        throw new Error(`Object type '${objectName}' not found`);
      }

      // Get or create collection
      const collection = await this.getCollection(actualObjectName, classInfo);

      // Execute the action
      const result = await this.executeAction(collection, action, args);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  /**
   * Get or create collection for an object
   */
  private async getCollection(
    objectName: string,
    classInfo: any,
  ): Promise<SmrtCollection<any>> {
    if (!this.collections.has(objectName)) {
      // Ensure we have a valid collection constructor
      if (
        !classInfo.collectionConstructor ||
        typeof classInfo.collectionConstructor !== 'function'
      ) {
        throw new Error(
          `No valid collection constructor found for ${objectName}`,
        );
      }

      const collection = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db: this.context.db,
      });

      // Verify the collection is actually a SmrtCollection instance
      if (!(collection instanceof SmrtCollection)) {
        throw new Error(
          `Collection for ${objectName} must extend SmrtCollection`,
        );
      }

      // Initialize the collection (database setup, etc.)
      await collection.initialize();

      this.collections.set(objectName, collection);
    }
    const collection = this.collections.get(objectName);
    if (!collection) {
      throw new Error(`Collection for ${objectName} not found`);
    }
    return collection;
  }

  /**
   * Execute action on collection
   */
  private async executeAction(
    collection: SmrtCollection<any>,
    action: string,
    args: any,
  ): Promise<any> {
    switch (action) {
      case 'list': {
        const listOptions: any = {
          limit: Math.min(args.limit || 50, 1000),
          offset: args.offset || 0,
        };

        if (args.where) {
          listOptions.where = args.where;
        }

        if (args.orderBy) {
          listOptions.orderBy = args.orderBy;
        }

        const results = await collection.list(listOptions);
        const total = await collection.count({ where: args.where || {} });

        return {
          data: results,
          meta: {
            total,
            limit: listOptions.limit,
            offset: listOptions.offset,
            count: results.length,
          },
        };
      }

      case 'get': {
        if (!args.id && !args.slug) {
          throw new Error('Either id or slug is required');
        }

        const filter = args.id ? args.id : args.slug;
        const item = await collection.get(filter);

        if (!item) {
          throw new Error('Object not found');
        }

        return item;
      }

      case 'create': {
        // Add user context if available
        const createData = { ...args };
        if (this.context.user) {
          createData.created_by = this.context.user.id;
          createData.owner_id = this.context.user.id;
        }

        const newItem = await collection.create(createData);
        await newItem.save();

        return newItem;
      }

      case 'update': {
        const { id, ...updateData } = args;
        if (!id) {
          throw new Error('ID is required for update');
        }

        const existing = await collection.get(id);
        if (!existing) {
          throw new Error('Object not found');
        }

        // Update properties
        Object.assign(existing, updateData);

        // Add user context
        if (this.context.user) {
          (existing as any).updated_by = this.context.user.id;
        }

        await existing.save();

        return existing;
      }

      case 'delete': {
        if (!args.id) {
          throw new Error('ID is required for delete');
        }

        const toDelete = await collection.get(args.id);
        if (!toDelete) {
          throw new Error('Object not found');
        }

        await toDelete.delete();

        return { success: true, message: 'Object deleted successfully' };
      }

      default:
        // Handle custom actions
        return this.executeCustomAction(collection, action, args);
    }
  }

  /**
   * Execute a custom action on a collection/object
   */
  private async executeCustomAction(
    collection: SmrtCollection<any>,
    action: string,
    args: any,
  ): Promise<any> {
    const { id, options = {}, ...directArgs } = args;

    try {
      // If an ID is provided, get the specific object and call the method on it
      if (id) {
        const object = await collection.get(id);
        if (!object) {
          throw new Error('Object not found');
        }

        // Check if the method exists on the object instance
        // Cast to any to access dynamic method names
        const objectWithMethods = object as any;
        if (typeof objectWithMethods[action] === 'function') {
          // Call the method with the provided options
          // If options is provided, use it; otherwise use directArgs
          const methodArgs =
            Object.keys(options).length > 0 ? options : directArgs;
          const result = await objectWithMethods[action](methodArgs);
          return result;
        } else {
          throw new Error(`Method '${action}' not found on object instance`);
        }
      } else {
        // No ID provided, try to call the method on the collection
        if (typeof (collection as any)[action] === 'function') {
          const methodArgs =
            Object.keys(options).length > 0 ? options : directArgs;
          const result = await (collection as any)[action](methodArgs);
          return result;
        } else {
          throw new Error(
            `Method '${action}' not found on collection. For object-specific actions, provide an 'id' parameter.`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to execute custom action '${action}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Generate MCP server info
   */
  getServerInfo() {
    return {
      name: this.config.server?.name,
      version: this.config.server?.version,
      description: this.config.description,
    };
  }

  /**
   * Generate complete MCP server with stdio transport
   *
   * Creates a runnable Node.js script that exposes SMRT objects as MCP tools.
   * The generated server includes:
   * - Stdio transport integration
   * - Tool registration from ObjectRegistry
   * - Error handling and logging
   * - Graceful shutdown
   *
   * @param options - Server generation options
   * @returns Promise that resolves when all files are written
   *
   * @example
   * ```typescript
   * const generator = new MCPGenerator({
   *   name: 'my-app',
   *   version: '1.0.0'
   * });
   *
   * await generator.generateServer({
   *   outputPath: '.smrt/mcp-server/index.js',
   *   serverName: 'my-app-mcp',
   *   debug: true
   * });
   * ```
   */
  async generateServer(
    options: {
      /** Path to output server file (relative or absolute) */
      outputPath?: string;

      /** Server name for configuration */
      serverName?: string;

      /** Server version */
      serverVersion?: string;

      /** Enable debug logging */
      debug?: boolean;

      /** Generate Claude Desktop configuration example */
      generateClaudeConfigFile?: boolean;

      /** Generate README documentation */
      generateReadme?: boolean;

      /** Generate modular directory structure (tools/, handlers/, config.ts) */
      modular?: boolean;
    } = {},
  ): Promise<void> {
    const {
      outputPath = '.smrt/mcp-server/index.js',
      serverName = this.config.name || 'smrt-mcp-server',
      serverVersion = this.config.version || '1.0.0',
      debug = false,
      generateClaudeConfigFile = false,
      generateReadme = false,
      modular = false,
    } = options;

    // Resolve output path
    const resolvedPath = resolve(process.cwd(), outputPath);
    const outputDir = dirname(resolvedPath);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    if (modular) {
      // Generate modular structure: tools/, handlers/, config.ts, index.js
      await this.generateModularServer(
        outputDir,
        serverName,
        serverVersion,
        debug,
      );
    } else {
      // Generate single-file server with static tools
      const tools = await this.generateTools();

      const runtimeOptions: RuntimeOptions = {
        name: serverName,
        version: serverVersion,
        description: this.config.description,
        config: this.config,
        context: this.context,
        debug,
        tools,
      };

      const serverCode = generateRuntimeBootstrap(runtimeOptions);

      // Write server file
      await writeFile(resolvedPath, serverCode, 'utf-8');
      console.log(`✅ Generated MCP server: ${resolvedPath}`);
    }

    // Generate Claude Desktop configuration example
    if (generateClaudeConfigFile) {
      const claudeConfig = generateClaudeConfig(serverName, resolvedPath);
      const claudeConfigPath = resolve(outputDir, 'claude-config.example.json');
      await writeFile(
        claudeConfigPath,
        JSON.stringify(claudeConfig, null, 2),
        'utf-8',
      );
      console.log(`✅ Generated Claude config example: ${claudeConfigPath}`);
    }

    // Generate README documentation
    if (generateReadme) {
      const readme = generateMCPDocumentation(serverName, outputPath);
      const readmePath = resolve(outputDir, 'MCP-README.md');
      await writeFile(readmePath, readme, 'utf-8');
      console.log(`✅ Generated MCP documentation: ${readmePath}`);
    }

    // Generate npm script suggestion
    const mcpScript = generateMCPScript(outputPath);
    console.log(`\n📝 Add this to your package.json scripts:`);
    console.log(`   "mcp": "${mcpScript}"\n`);
  }

  /**
   * Generate modular MCP server structure
   *
   * Creates separate files for tools, handlers, configuration, and main entry point.
   * This makes the generated server easier to customize and extend.
   *
   * @param outputDir - Directory to generate files in
   * @param serverName - Server name
   * @param serverVersion - Server version
   * @param debug - Enable debug logging
   */
  private async generateModularServer(
    outputDir: string,
    serverName: string,
    serverVersion: string,
    debug: boolean,
  ): Promise<void> {
    // Create subdirectories
    const toolsDir = resolve(outputDir, 'tools');
    const handlersDir = resolve(outputDir, 'handlers');

    await mkdir(toolsDir, { recursive: true });
    await mkdir(handlersDir, { recursive: true });

    // Generate config.ts
    const configPath = resolve(outputDir, 'config.ts');
    const configCode = this.generateConfigFile(
      serverName,
      serverVersion,
      debug,
    );
    await writeFile(configPath, configCode, 'utf-8');
    console.log(`✅ Generated config: ${configPath}`);

    // Generate tools/index.ts with tool definitions
    const toolsPath = resolve(toolsDir, 'index.ts');
    const toolsCode = await this.generateToolsFile();
    await writeFile(toolsPath, toolsCode, 'utf-8');
    console.log(`✅ Generated tools: ${toolsPath}`);

    // Generate handlers/index.ts with tool call handlers
    const handlersPath = resolve(handlersDir, 'index.ts');
    const handlersCode = await this.generateHandlersFile();
    await writeFile(handlersPath, handlersCode, 'utf-8');
    console.log(`✅ Generated handlers: ${handlersPath}`);

    // Generate main index.js entry point
    const indexPath = resolve(outputDir, 'index.js');
    const indexCode = this.generateModularIndex();
    await writeFile(indexPath, indexCode, 'utf-8');
    console.log(`✅ Generated MCP server: ${indexPath}`);
  }

  /**
   * Generate configuration file for modular server
   */
  private generateConfigFile(
    serverName: string,
    serverVersion: string,
    debug: boolean,
  ): string {
    return `/**
 * MCP Server Configuration
 * Auto-generated by @happyvertical/smrt-core
 */

export const SERVER_NAME = ${JSON.stringify(serverName)};
export const SERVER_VERSION = ${JSON.stringify(serverVersion)};
export const SERVER_DESCRIPTION = ${JSON.stringify(this.config.description)};
export const DEBUG = ${debug};
`;
  }

  /**
   * Generate tools definitions file for modular server
   */
  private async generateToolsFile(): Promise<string> {
    const tools = await this.generateTools();

    return `/**
 * MCP Tools Definitions
 * Auto-generated from SMRT objects
 */

export const tools: Array<{
  name: string;
  description: string;
  inputSchema: any;
}> = ${JSON.stringify(tools, null, 2)};
`;
  }

  /**
   * Generate switch cases for tool execution
   */
  private async generateToolSwitchCases(
    indent: string = '    ',
  ): Promise<string> {
    const tools = await this.generateTools();

    const capitalize = (str: string) =>
      str.charAt(0).toUpperCase() + str.slice(1);

    const switchCases = tools
      .map((tool) => {
        const [objectName, action] = tool.name.split('_');

        switch (action) {
          case 'list':
            return `${indent}case '${tool.name}': {
${indent}  const limit = args.limit ?? 50;
${indent}  const offset = args.offset ?? 0;
${indent}  const where = args.where ?? {};

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const items = await collection.list({ where, limit, offset });
${indent}  return { content: [{ type: 'text', text: JSON.stringify(items) }] };
${indent}}`;

          case 'get':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id && !args.slug) {
${indent}    throw new Error('Either id or slug is required');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const filter = args.id || args.slug;
${indent}  const item = await collection.get(filter);

${indent}  if (!item) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  return { content: [{ type: 'text', text: JSON.stringify(item) }] };
${indent}}`;

          case 'create':
            return `${indent}case '${tool.name}': {
${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const newItem = await collection.create(args);
${indent}  await newItem.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(newItem) }] };
${indent}}`;

          case 'update':
            return `${indent}case '${tool.name}': {
${indent}  const { id, ...updateData } = args;
${indent}  if (!id) {
${indent}    throw new Error('ID is required for update');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const existing = await collection.get(id);
${indent}  if (!existing) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  Object.assign(existing, updateData);
${indent}  await existing.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(existing) }] };
${indent}}`;

          case 'delete':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id) {
${indent}    throw new Error('ID is required for delete');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const toDelete = await collection.get(args.id);
${indent}  if (!toDelete) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  await toDelete.delete();

${indent}  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Object deleted successfully' }) }] };
${indent}}`;

          default:
            // Custom action
            return `${indent}case '${tool.name}': {
${indent}  const { id, options = {}, ...directArgs } = args;

${indent}  if (!id) {
${indent}    throw new Error('ID is required for custom action ${action}');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const object = await collection.get(id);
${indent}  if (!object) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  if (typeof object['${action}'] !== 'function') {
${indent}    throw new Error('Method ${action} not found on object');
${indent}  }

${indent}  const methodArgs = Object.keys(options).length > 0 ? options : directArgs;
${indent}  const result = await object['${action}'](methodArgs);

${indent}  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
${indent}}`;
        }
      })
      .join('\n\n');

    return switchCases;
  }

  /**
   * Generate handlers file for modular server
   */
  private async generateHandlersFile(): Promise<string> {
    const switchCases = await this.generateToolSwitchCases('      ');

    return `/**
 * MCP Tool Call Handlers
 * Auto-generated from SMRT objects
 */

import { ObjectRegistry } from '@happyvertical/smrt-core/registry';

/**
 * Handle tool call request
 */
export async function handleToolCall(
  name: string,
  arguments: any = {},
  aiConfig: any = {}
) {
  try {
    let result;
    const args = arguments;

    switch (name) {
${switchCases}

      default:
        throw new Error(\`Unknown tool: \${name}\`);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      content: [
        {
          type: 'text',
          text: \`Error executing tool \${name}: \${errorMessage}\`,
        },
      ],
      isError: true,
    };
  }
}
`;
  }

  /**
   * Generate modular index file (main entry point)
   */
  private generateModularIndex(): string {
    return `#!/usr/bin/env node
/**
 * Auto-generated MCP Server
 * Generated by @happyvertical/smrt-core MCPGenerator
 *
 * This server exposes SMRT objects as MCP tools for AI integration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { getAI } from '@happyvertical/ai';

import { SERVER_NAME, SERVER_VERSION, DEBUG } from './config.js';
import { tools } from './tools/index.js';
import { handleToolCall } from './handlers/index.js';

/**
 * Main server startup function
 */
async function main() {
  try {
    if (DEBUG) {
      console.error(\`[MCP] Starting server: \${SERVER_NAME} v\${SERVER_VERSION}\`);
      console.error(\`[MCP] Available tools:\`, tools.map(t => t.name).join(', '));
    }

    // Load configuration from environment and .smrt.config files
    const appConfig = await config.load();
    const aiConfig = appConfig?.ai || {};

    // Create MCP server
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register ListTools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (DEBUG) {
        console.error(\`[MCP] ListTools request received\`);
      }

      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Register CallTool handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      if (DEBUG) {
        console.error(\`[MCP] CallTool request: \${name}\`);
        console.error(\`[MCP] Arguments:\`, JSON.stringify(args, null, 2));
      }

      return await handleToolCall(name, args, aiConfig);
    });

    // Setup stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    if (DEBUG) {
      console.error(\`[MCP] Server connected and ready\`);
    }

    // Handle graceful shutdown
    const shutdown = async () => {
      if (DEBUG) {
        console.error(\`[MCP] Shutting down gracefully\`);
      }
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[MCP] Fatal error during server startup:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[MCP] Unhandled error:', error);
  process.exit(1);
});
`;
  }
}
