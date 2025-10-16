/**
 * Get the @smrt() decorator configuration for a SMRT object
 */

import { ObjectRegistry } from '../../registry.js';
import type { GetObjectConfigInput, ObjectConfig } from '../types.js';

/**
 * Get object decorator configuration
 */
export async function getObjectConfig(
  input: GetObjectConfigInput,
): Promise<ObjectConfig> {
  try {
    const { className, format = 'json' } = input;

    // Get config from registry
    const config = ObjectRegistry.getConfig(className);
    if (!config) {
      throw new Error(`Class '${className}' not found in ObjectRegistry`);
    }

    // Get fields
    const fieldsMap = ObjectRegistry.getFields(className);
    const fields = Array.from(fieldsMap.entries()).map(([name, field]) => ({
      name,
      type: field.type,
      required: field.options?.required || false,
      default: field.options?.default,
      description: field.options?.description,
      constraints: extractConstraints(field.options || {}),
    }));

    // Get class info for custom methods
    const classInfo = ObjectRegistry.getClass(className);
    const customMethods: string[] = [];

    if (classInfo) {
      const prototype = classInfo.constructor.prototype;
      const methodNames = Object.getOwnPropertyNames(prototype);

      // Filter to custom methods (exclude constructor and standard methods)
      for (const methodName of methodNames) {
        if (
          methodName !== 'constructor' &&
          typeof (prototype as any)[methodName] === 'function' &&
          !['save', 'delete', 'loadFromId', 'loadFromSlug', 'is', 'do'].includes(
            methodName,
          )
        ) {
          customMethods.push(methodName);
        }
      }
    }

    // Build object config
    const objectConfig: ObjectConfig = {
      className,
      decorator: {
        api: config.api,
        mcp: config.mcp,
        cli: typeof config.cli === 'boolean' ? config.cli : undefined,
        hooks: config.hooks
          ? Object.fromEntries(
              Object.entries(config.hooks)
                .filter(([_, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : undefined,
      },
      fields,
      customMethods,
    };

    // Format output
    let output: string;

    switch (format) {
      case 'yaml':
        output = formatAsYAML(objectConfig);
        break;
      case 'json':
      default:
        output = JSON.stringify(objectConfig, null, 2);
        break;
    }

    return objectConfig;
  } catch (error) {
    throw new Error(
      `Failed to get object config: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Extract constraints from field options
 */
function extractConstraints(options: any): Record<string, any> {
  const constraints: Record<string, any> = {};

  if (options.min !== undefined) constraints.min = options.min;
  if (options.max !== undefined) constraints.max = options.max;
  if (options.minLength !== undefined)
    constraints.minLength = options.minLength;
  if (options.maxLength !== undefined)
    constraints.maxLength = options.maxLength;
  if (options.pattern !== undefined) constraints.pattern = options.pattern;
  if (options.unique !== undefined) constraints.unique = options.unique;
  if (options.index !== undefined) constraints.index = options.index;

  return constraints;
}

/**
 * Format config as YAML (simplified - not full YAML spec)
 */
function formatAsYAML(config: ObjectConfig): string {
  let yaml = `className: ${config.className}\n\n`;

  yaml += `decorator:\n`;
  if (config.decorator.api) {
    yaml += `  api:\n`;
    if (config.decorator.api.include) {
      yaml += `    include:\n`;
      for (const item of config.decorator.api.include) {
        yaml += `      - ${item}\n`;
      }
    }
    if (config.decorator.api.exclude) {
      yaml += `    exclude:\n`;
      for (const item of config.decorator.api.exclude) {
        yaml += `      - ${item}\n`;
      }
    }
  }

  if (config.decorator.mcp) {
    yaml += `  mcp:\n`;
    if (config.decorator.mcp.include) {
      yaml += `    include:\n`;
      for (const item of config.decorator.mcp.include) {
        yaml += `      - ${item}\n`;
      }
    }
    if (config.decorator.mcp.exclude) {
      yaml += `    exclude:\n`;
      for (const item of config.decorator.mcp.exclude) {
        yaml += `      - ${item}\n`;
      }
    }
  }

  if (config.decorator.cli !== undefined) {
    yaml += `  cli: ${config.decorator.cli}\n`;
  }

  if (config.decorator.hooks && Object.keys(config.decorator.hooks).length > 0) {
    yaml += `  hooks:\n`;
    for (const [key, value] of Object.entries(config.decorator.hooks)) {
      yaml += `    ${key}: ${value}\n`;
    }
  }

  yaml += `\nfields:\n`;
  for (const field of config.fields) {
    yaml += `  - name: ${field.name}\n`;
    yaml += `    type: ${field.type}\n`;
    yaml += `    required: ${field.required}\n`;
    if (field.description) {
      yaml += `    description: ${field.description}\n`;
    }
  }

  if (config.customMethods.length > 0) {
    yaml += `\ncustomMethods:\n`;
    for (const method of config.customMethods) {
      yaml += `  - ${method}\n`;
    }
  }

  return yaml;
}
