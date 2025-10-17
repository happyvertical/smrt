/**
 * Get the schema (fields, types, constraints) for a SMRT object
 */

import { ObjectRegistry } from '../../registry.js';
import type { FieldDefinition, GetObjectSchemaInput } from '../types.js';

/**
 * Get object schema with field definitions
 */
export async function getObjectSchema(
  input: GetObjectSchemaInput,
): Promise<{ className: string; fields: FieldDefinition[]; format: string }> {
  try {
    const { className, format = 'json' } = input;

    // Get fields from registry
    const fieldsMap = ObjectRegistry.getFields(className);
    if (!fieldsMap) {
      throw new Error(`Class '${className}' not found in ObjectRegistry`);
    }

    // Convert to FieldDefinition array
    const fields: FieldDefinition[] = [];

    for (const [name, field] of fieldsMap.entries()) {
      fields.push({
        name,
        type: field.type,
        required: field.options?.required || false,
        default: field.options?.default,
        description: field.options?.description,
        constraints: extractConstraints(field.options || {}),
      });
    }

    // Format output based on requested format
    let output: string;

    switch (format) {
      case 'typescript':
        output = formatAsTypeScript(className, fields);
        break;
      case 'table':
        output = formatAsMarkdownTable(className, fields);
        break;
      case 'json':
      default:
        output = JSON.stringify({ className, fields }, null, 2);
        break;
    }

    return {
      className,
      fields,
      format,
    };
  } catch (error) {
    throw new Error(
      `Failed to get object schema: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
 * Format schema as TypeScript interface
 */
function formatAsTypeScript(
  className: string,
  fields: FieldDefinition[],
): string {
  let ts = `interface ${className}Data {\n`;

  for (const field of fields) {
    const optional = field.required ? '' : '?';
    const type = mapFieldTypeToTS(field.type);
    const comment = field.description ? `  /** ${field.description} */\n` : '';
    ts += `${comment}  ${field.name}${optional}: ${type};\n`;
  }

  ts += '}\n';

  return ts;
}

/**
 * Format schema as markdown table
 */
function formatAsMarkdownTable(
  className: string,
  fields: FieldDefinition[],
): string {
  let md = `# Schema for ${className}\n\n`;
  md += `| Field | Type | Required | Default | Constraints |\n`;
  md += `|-------|------|----------|---------|-------------|\n`;

  for (const field of fields) {
    const required = field.required ? '✓' : '✗';
    const defaultValue =
      field.default !== undefined ? JSON.stringify(field.default) : '-';
    const constraints =
      Object.keys(field.constraints || {}).length > 0
        ? Object.entries(field.constraints || {})
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '-';

    md += `| ${field.name} | ${field.type} | ${required} | ${defaultValue} | ${constraints} |\n`;
  }

  return md;
}

/**
 * Map field type to TypeScript type
 */
function mapFieldTypeToTS(fieldType: string): string {
  switch (fieldType) {
    case 'text':
      return 'string';
    case 'integer':
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'Date';
    case 'json':
      return 'Record<string, any>';
    case 'foreignKey':
      return 'string';
    default:
      return 'any';
  }
}
