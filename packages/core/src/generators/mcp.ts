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
   * Generate all available tools from registered objects
   */
  generateTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    const registeredClasses = ObjectRegistry.getAllClasses();

    for (const [name, _classInfo] of registeredClasses) {
      const config = ObjectRegistry.getConfig(name);
      const mcpConfig = config.mcp || {};

      // Skip excluded endpoints
      const excluded = mcpConfig.exclude || [];
      const included = mcpConfig.include;

      const shouldInclude = (endpoint: string) => {
        if (included && !included.includes(endpoint)) return false;
        if (excluded.includes(endpoint)) return false;
        return true;
      };

      const objectTools = this.generateObjectTools(name, shouldInclude);
      tools.push(...objectTools);
    }

    return tools;
  }

  /**
   * Generate tools for a specific object
   */
  private generateObjectTools(
    objectName: string,
    shouldInclude: (endpoint: string) => boolean,
  ): MCPTool[] {
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
          required: [],
        },
      });
    }

    // CREATE tool
    if (shouldInclude('create')) {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const [fieldName, field] of fields) {
        properties[fieldName] = this.fieldToMCPSchema(field);
        if (field.options?.required) {
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

    // CUSTOM ACTIONS
    if (classInfo) {
      const config = ObjectRegistry.getConfig(objectName);
      const mcpConfig = config.mcp || {};
      const included = mcpConfig.include;
      const excluded = mcpConfig.exclude || [];

      // If specific actions are included, check for custom actions
      if (included) {
        for (const action of included) {
          // Skip standard CRUD actions (already handled above)
          if (['list', 'get', 'create', 'update', 'delete'].includes(action)) {
            continue;
          }

          // Skip if excluded
          if (excluded.includes(action)) {
            continue;
          }

          // Validate that the method exists on the class
          const isValid = this.validateCustomMethod(
            classInfo.constructor,
            action,
          );

          if (isValid) {
            const toolName = `${lowerName}_${action}`;
            tools.push({
              name: toolName,
              description: `Execute ${action} action on ${objectName}`,
              inputSchema: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'ID of the object (optional for some actions)',
                  },
                  options: {
                    type: 'object',
                    description: 'Additional options for the custom action',
                    additionalProperties: true,
                  },
                },
                required: [],
              },
            });
          } else {
            console.warn(
              `Warning: Custom action '${action}' specified in MCP config for ${objectName}, but method ${action}() not found on class`,
            );
          }
        }
      }
    }

    return tools;
  }

  /**
   * Convert field definition to MCP schema
   */
  private fieldToMCPSchema(field: any): any {
    const schema: any = {
      description: field.options?.description || `${field.type} field`,
    };

    switch (field.type) {
      case 'text':
        schema.type = 'string';
        if (field.options?.maxLength)
          schema.maxLength = field.options.maxLength;
        if (field.options?.minLength)
          schema.minLength = field.options.minLength;
        break;
      case 'integer':
        schema.type = 'integer';
        if (field.options?.min !== undefined)
          schema.minimum = field.options.min;
        if (field.options?.max !== undefined)
          schema.maximum = field.options.max;
        break;
      case 'decimal':
        schema.type = 'number';
        if (field.options?.min !== undefined)
          schema.minimum = field.options.min;
        if (field.options?.max !== undefined)
          schema.maximum = field.options.max;
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
        schema.description = `ID of related ${field.options?.related || 'object'}`;
        break;
      default:
        schema.type = 'string';
    }

    if (field.options?.default !== undefined) {
      schema.default = field.options.default;
    }

    return schema;
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
   * Handle MCP tool calls
   */
  async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      // Parse tool name: objectname_action
      const [objectName, action] = name.split('_');

      if (!objectName || !action) {
        throw new Error(`Invalid tool name format: ${name}`);
      }

      // Find the registered class (case-insensitive)
      const registeredClasses = ObjectRegistry.getAllClasses();
      let classInfo = null;
      let actualObjectName = '';

      for (const [registeredName, info] of registeredClasses) {
        if (registeredName.toLowerCase() === objectName.toLowerCase()) {
          classInfo = info;
          actualObjectName = registeredName;
          break;
        }
      }

      if (!classInfo) {
        throw new Error(`Object type '${objectName}' not found`);
      }

      // Get or create collection
      const collection = this.getCollection(actualObjectName, classInfo);

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
  private getCollection(
    objectName: string,
    classInfo: any,
  ): SmrtCollection<any> {
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
        if (typeof object[action] === 'function') {
          // Call the method with the provided options
          // If options is provided, use it; otherwise use directArgs
          const methodArgs =
            Object.keys(options).length > 0 ? options : directArgs;
          const result = await object[action](methodArgs);
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
   *   outputPath: 'dist/mcp-server.js',
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
    } = {},
  ): Promise<void> {
    const {
      outputPath = 'dist/mcp-server.js',
      serverName = this.config.name || 'smrt-mcp-server',
      serverVersion = this.config.version || '1.0.0',
      debug = false,
      generateClaudeConfigFile = true,
      generateReadme = true,
    } = options;

    // Resolve output path
    const resolvedPath = resolve(process.cwd(), outputPath);
    const outputDir = dirname(resolvedPath);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Generate server code
    const runtimeOptions: RuntimeOptions = {
      name: serverName,
      version: serverVersion,
      description: this.config.description,
      config: this.config,
      context: this.context,
      debug,
    };

    const serverCode = generateRuntimeBootstrap(runtimeOptions);

    // Write server file
    await writeFile(resolvedPath, serverCode, 'utf-8');
    console.log(`✅ Generated MCP server: ${resolvedPath}`);

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
}
