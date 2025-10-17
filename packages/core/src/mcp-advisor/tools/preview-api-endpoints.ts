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
): Promise<{ endpoints: ApiEndpoint[]; basePath: string }> {
  try {
    const { className, basePath = '/api/v1' } = input;

    // Get class configuration
    const config = ObjectRegistry.getConfig(className);
    if (!config) {
      throw new Error(`Class '${className}' not found in ObjectRegistry`);
    }

    const apiConfig = config.api || {};
    const included = apiConfig.include;
    const excluded = apiConfig.exclude || [];

    const shouldInclude = (endpoint: string) => {
      if (included && !included.includes(endpoint)) return false;
      if (excluded.includes(endpoint)) return false;
      return true;
    };

    // Get fields for request/response documentation
    const fields = ObjectRegistry.getFields(className);
    const fieldsList = Array.from(fields.entries()).map(([name, field]) => ({
      name,
      type: field.type,
      required: field.options?.required || false,
    }));

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
          },
          {
            name: 'offset',
            type: 'integer',
            required: false,
            location: 'query',
          },
          {
            name: 'orderBy',
            type: 'string',
            required: false,
            location: 'query',
          },
          {
            name: 'where',
            type: 'object',
            required: false,
            location: 'query',
          },
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
          },
          ...fieldsList.map((field) => ({
            name: field.name,
            type: field.type,
            required: false,
            location: 'body' as const,
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
              },
              {
                name: 'options',
                type: 'object',
                required: false,
                location: 'body',
              },
            ],
          });
        }
      }
    }

    // Format as markdown table
    const markdown = formatEndpointsAsMarkdown(endpoints, className);

    return {
      endpoints,
      basePath,
    };
  } catch (error) {
    throw new Error(
      `Failed to preview API endpoints: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Format endpoints as markdown table
 */
function formatEndpointsAsMarkdown(
  endpoints: ApiEndpoint[],
  className: string,
): string {
  let markdown = `# API Endpoints for ${className}\n\n`;
  markdown += `| Method | Path | Description |\n`;
  markdown += `|--------|------|-------------|\n`;

  for (const endpoint of endpoints) {
    markdown += `| ${endpoint.method} | ${endpoint.path} | ${endpoint.description} |\n`;
  }

  return markdown;
}
