/**
 * Preview auto-generated REST API endpoints for a SMRT class
 */

import { ObjectRegistry } from '../../registry.js';
import type { ApiEndpoint, PreviewApiEndpointsInput } from '../types.js';

/**
 * Preview API endpoints that would be generated for a class
 */
export async function previewApiEndpoints(
  input: PreviewApiEndpointsInput,
): Promise<{ endpoints: ApiEndpoint[]; basePath: string; markdown: string }> {
  try {
    const { className, basePath = '/api/v1' } = input;

    // Get class configuration
    const config = ObjectRegistry.getConfig(className);
    if (!config) {
      throw new Error(`Class '${className}' not found in ObjectRegistry`);
    }

    const apiConfig = config.api;
    const included: string[] | undefined =
      typeof apiConfig === 'object' ? apiConfig?.include : undefined;
    const excluded: string[] =
      typeof apiConfig === 'object' && apiConfig?.exclude
        ? apiConfig.exclude
        : [];

    const shouldInclude = (endpoint: string) => {
      if (included && !included.includes(endpoint)) return false;
      if (excluded.includes(endpoint)) return false;
      return true;
    };

    // Get fields for request/response documentation
    const fields = ObjectRegistry.getFields(className);
    const fieldsList = Array.from(fields.entries()).map(([name, field]) => {
      const type = field.type;
      return {
        name,
        type,
        required: field._meta?.required || false,
        description:
          typeof field._meta?.description === 'string'
            ? field._meta.description
            : undefined,
        example: sampleValueForType(type, name),
      };
    });

    // Generate endpoint definitions
    const endpoints: ApiEndpoint[] = [];
    const lowerName = className.toLowerCase();
    const pluralName = `${lowerName}s`;

    // LIST endpoint
    if (shouldInclude('list')) {
      endpoints.push({
        method: 'GET',
        path: `${basePath}/${pluralName}`,
        description: `List all ${className} objects with optional filtering and pagination`,
        parameters: [
          {
            name: 'limit',
            type: 'integer',
            required: false,
            location: 'query',
            description: 'Maximum number of objects to return',
            example: 25,
          },
          {
            name: 'offset',
            type: 'integer',
            required: false,
            location: 'query',
            description: 'Number of objects to skip',
            example: 0,
          },
          {
            name: 'orderBy',
            type: 'string',
            required: false,
            location: 'query',
            description: 'SQL-style ordering expression',
            example: 'created_at DESC',
          },
          ...fieldsList.map((field) => ({
            name: field.name,
            type: field.type,
            required: false,
            location: 'query' as const,
            description: `Filter by ${field.name}. Operator suffixes like [gt], [gte], [lt], [lte], [ne], [in], and [like] are also supported.`,
            example: field.example,
          })),
        ],
      });
    }

    // GET endpoint
    if (shouldInclude('get')) {
      endpoints.push({
        method: 'GET',
        path: `${basePath}/${pluralName}/:id`,
        description: `Get a specific ${className} by ID or slug`,
        parameters: [
          {
            name: 'id',
            type: 'string',
            required: true,
            location: 'path',
            description: `${className} id or slug`,
            example: 'example-id',
          },
        ],
      });
    }

    // CREATE endpoint
    if (shouldInclude('create')) {
      endpoints.push({
        method: 'POST',
        path: `${basePath}/${pluralName}`,
        description: `Create a new ${className}`,
        parameters: fieldsList.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
          location: 'body',
          description: field.description,
          example: field.example,
        })),
      });
    }

    // UPDATE endpoint
    if (shouldInclude('update')) {
      endpoints.push({
        method: 'PUT',
        path: `${basePath}/${pluralName}/:id`,
        description: `Update an existing ${className}`,
        parameters: [
          {
            name: 'id',
            type: 'string',
            required: true,
            location: 'path',
            description: `${className} id or slug`,
            example: 'example-id',
          },
          ...fieldsList.map((field) => ({
            name: field.name,
            type: field.type,
            required: false,
            location: 'body' as const,
            description: field.description,
            example: field.example,
          })),
        ],
      });
    }

    // DELETE endpoint
    if (shouldInclude('delete')) {
      endpoints.push({
        method: 'DELETE',
        path: `${basePath}/${pluralName}/:id`,
        description: `Delete a ${className} by ID`,
        parameters: [
          {
            name: 'id',
            type: 'string',
            required: true,
            location: 'path',
            description: `${className} id or slug`,
            example: 'example-id',
          },
        ],
      });
    }

    // Custom actions
    if (included) {
      for (const action of included) {
        if (['list', 'get', 'create', 'update', 'delete'].includes(action)) {
          continue;
        }

        if (!excluded.includes(action)) {
          endpoints.push({
            method: 'POST',
            path: `${basePath}/${pluralName}/:id/${action}`,
            description: `Execute ${action} action on ${className}`,
            parameters: [
              {
                name: 'id',
                type: 'string',
                required: true,
                location: 'path',
                description: `${className} id or slug`,
                example: 'example-id',
              },
              {
                name: 'options',
                type: 'object',
                required: false,
                location: 'body',
                description: `Options for the ${action} action`,
                example: {},
              },
            ],
          });
        }
      }
    }

    const endpointsWithExamples = endpoints.map((endpoint) => ({
      ...endpoint,
      example: buildCurlExample(endpoint),
    }));

    return {
      endpoints: endpointsWithExamples,
      basePath,
      markdown: formatEndpointsAsMarkdown(endpointsWithExamples, className),
    };
  } catch (error) {
    throw new Error(
      `Failed to preview API endpoints: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Generate a deterministic example value for endpoint documentation.
 */
function sampleValueForType(type: string, name: string): unknown {
  const normalizedType = type.toLowerCase();
  const normalizedName = name.toLowerCase();

  if (normalizedName === 'id' || normalizedName.endsWith('id')) {
    return 'example-id';
  }

  if (
    normalizedType.includes('integer') ||
    normalizedType.includes('int') ||
    normalizedType === 'number'
  ) {
    return 1;
  }

  if (
    normalizedType.includes('decimal') ||
    normalizedType.includes('float') ||
    normalizedType.includes('double')
  ) {
    return 9.99;
  }

  if (normalizedType.includes('boolean')) {
    return true;
  }

  if (
    normalizedType.includes('datetime') ||
    normalizedType.includes('timestamp') ||
    normalizedType === 'date'
  ) {
    return '2026-01-01T00:00:00.000Z';
  }

  if (normalizedType.includes('json') || normalizedType.includes('object')) {
    return {};
  }

  if (normalizedType.includes('array')) {
    return [];
  }

  return `example-${toKebabCase(name)}`;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildCurlExample(endpoint: ApiEndpoint): string {
  const path = endpoint.path.replaceAll(':id', 'example-id');
  const url = new URL(`http://localhost:3000${path}`);

  for (const parameter of endpoint.parameters ?? []) {
    if (parameter.location !== 'query') {
      continue;
    }
    url.searchParams.set(parameter.name, formatQueryValue(parameter));
  }

  const body = buildBodyExample(endpoint);
  const parts = [`curl -X ${endpoint.method} "${url.toString()}"`];
  if (body) {
    parts.push('-H "Content-Type: application/json"');
    parts.push(`-d '${JSON.stringify(body)}'`);
  }

  return parts.join(' ');
}

function buildBodyExample(
  endpoint: ApiEndpoint,
): Record<string, unknown> | null {
  const bodyParameters =
    endpoint.parameters?.filter((parameter) => parameter.location === 'body') ??
    [];
  if (bodyParameters.length === 0) {
    return null;
  }

  const body: Record<string, unknown> = {};
  for (const parameter of bodyParameters) {
    body[parameter.name] =
      parameter.example ?? sampleValueForType(parameter.type, parameter.name);
  }

  return body;
}

function formatExampleValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? '';
}

function formatQueryValue(
  parameter: NonNullable<ApiEndpoint['parameters']>[number],
): string {
  return formatExampleValue(
    parameter.example ?? sampleValueForType(parameter.type, parameter.name),
  );
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br />');
}

/**
 * Format endpoints as copyable markdown sections.
 */
function formatEndpointsAsMarkdown(
  endpoints: ApiEndpoint[],
  className: string,
): string {
  let markdown = `# API Endpoints for ${className}\n\n`;

  for (const endpoint of endpoints) {
    markdown += `## ${endpoint.method} ${endpoint.path}\n\n`;
    markdown += `${endpoint.description}\n\n`;
    markdown += `| Parameter | Location | Type | Required | Example | Description |\n`;
    markdown += `|-----------|----------|------|----------|---------|-------------|\n`;

    if (endpoint.parameters?.length) {
      for (const parameter of endpoint.parameters) {
        markdown +=
          `| ${escapeMarkdownCell(parameter.name)}` +
          ` | ${parameter.location}` +
          ` | ${escapeMarkdownCell(parameter.type)}` +
          ` | ${parameter.required ? 'yes' : 'no'}` +
          ` | ${escapeMarkdownCell(formatExampleValue(parameter.example))}` +
          ` | ${escapeMarkdownCell(parameter.description ?? '')} |\n`;
      }
    } else {
      markdown += `| _none_ | | | | | |\n`;
    }

    markdown += `\nExample:\n\n`;
    markdown += `\`\`\`bash\n${endpoint.example}\n\`\`\`\n\n`;
  }

  return markdown;
}
