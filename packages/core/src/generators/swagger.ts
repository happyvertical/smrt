/**
 * OpenAPI documentation generation for smrt APIs
 *
 * Lightweight implementation with optional Swagger UI
 */

import { ObjectRegistry } from '../registry';
import type { FieldDefinition } from '../scanner/types';

export interface OpenAPIConfig {
  title?: string;
  version?: string;
  description?: string;
  basePath?: string;
  serverUrl?: string;
}

/**
 * Loose structural types for the generated OpenAPI 3.0 document. The generator
 * builds these objects by progressively assigning heterogeneous spec fields, so
 * the value surface is intentionally open (`unknown`) rather than a fully-typed
 * OpenAPI model (no shared OpenAPI types are available in this package).
 */
type OpenAPISchemaObject = Record<string, unknown>;
type OpenAPIPathItem = Record<string, unknown>;
type OpenAPISpec = Record<string, unknown>;

/**
 * Minimal Express-like surface consumed by {@link setupSwaggerUI}. Avoids a hard
 * dependency on Express types for what is an optional integration helper.
 */
interface SwaggerApp {
  use(path: string, ...handlers: unknown[]): unknown;
  get(path: string, ...handlers: unknown[]): unknown;
}

/**
 * Generate OpenAPI specification (tree-shakeable)
 */
export function generateOpenAPISpec(config: OpenAPIConfig = {}): OpenAPISpec {
  const {
    title = 'smrt API',
    version = '1.0.0',
    description = 'Auto-generated API from smrt objects',
    basePath = '/api/v1',
    serverUrl = 'http://localhost:3000',
  } = config;

  const spec = {
    openapi: '3.0.3',
    info: { title, version, description },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: generateSchemas(),
      responses: {
        ValidationError: {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  details: { type: 'string' },
                },
              },
            },
          },
        },
        NotFound: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    paths: generatePaths(basePath),
  };

  return spec;
}

/**
 * Generate schemas for all registered objects
 */
function generateSchemas(): Record<string, OpenAPISchemaObject> {
  const schemas: Record<string, OpenAPISchemaObject> = {};
  const registeredClasses = ObjectRegistry.getAllClasses();

  for (const [key, classInfo] of registeredClasses) {
    // Issue #951: Use simple name for schema keys, not the qualified map key
    const name = classInfo.name || key;
    // `api: false` disables REST generation (see rest.ts) and is already
    // skipped in generatePaths(); mirror that here so component schemas don't
    // leak the field shape of a surface with no working handlers. Skip ONLY
    // when api is explicitly false — default (undefined) and
    // `{ include: [...] }` configs still publish their schema (#1540).
    if (ObjectRegistry.getConfig(name).api === false) {
      continue;
    }
    schemas[name] = generateObjectSchema(name);
    schemas[`${name}List`] = {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { $ref: `#/components/schemas/${name}` },
        },
        meta: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            count: { type: 'integer' },
          },
        },
      },
    };
  }

  return schemas;
}

/**
 * Generate schema for a specific object
 */
function generateObjectSchema(objectName: string): OpenAPISchemaObject {
  const fields = ObjectRegistry.getFields(objectName);
  const properties: Record<string, OpenAPISchemaObject> = {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  };

  const required = ['id'];

  for (const [fieldName, field] of fields) {
    properties[fieldName] = fieldToOpenAPISchema(field);
    if (field._meta?.required) {
      required.push(fieldName);
    }
  }

  return { type: 'object', properties, required };
}

/**
 * Convert field to OpenAPI schema
 */
function fieldToOpenAPISchema(field: FieldDefinition): OpenAPISchemaObject {
  const schema: OpenAPISchemaObject = {
    description: field._meta?.description || '',
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
      schema.format = 'float';
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
      schema.additionalProperties = true;
      break;
    case 'foreignKey':
      schema.type = 'string';
      schema.format = 'uuid';
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
 * Generate API paths
 */
function generatePaths(basePath: string): Record<string, OpenAPIPathItem> {
  const paths: Record<string, OpenAPIPathItem> = {};
  const registeredClasses = ObjectRegistry.getAllClasses();

  for (const [key, classInfo] of registeredClasses) {
    // Issue #951: Use simple name, not the qualified map key
    const name = classInfo.name || key;
    const pluralName = pluralize(name.toLowerCase());
    const objectPath = `${basePath}/${pluralName}`;

    const config = ObjectRegistry.getConfig(name);
    const apiConfig = config.api;
    // `api: false` disables REST generation (see rest.ts); don't advertise its
    // paths in the OpenAPI spec either, or the spec leaks the shape of a
    // surface that has no working handlers (#1540).
    if (apiConfig === false) {
      continue;
    }
    const excluded: string[] =
      typeof apiConfig === 'object' && apiConfig?.exclude
        ? apiConfig.exclude
        : [];
    const included: string[] | undefined =
      typeof apiConfig === 'object' ? apiConfig?.include : undefined;

    const shouldInclude = (
      endpoint: 'list' | 'get' | 'create' | 'update' | 'delete',
    ) => {
      if (included && !included.includes(endpoint)) return false;
      if (excluded.includes(endpoint)) return false;
      return true;
    };

    // Collection endpoints
    paths[objectPath] = {};

    if (shouldInclude('list')) {
      paths[objectPath].get = {
        summary: `List ${name} objects`,
        tags: [name],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${name}List` },
              },
            },
          },
        },
      };
    }

    if (shouldInclude('create')) {
      paths[objectPath].post = {
        summary: `Create ${name}`,
        tags: [name],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${name}` },
            },
          },
        },
        responses: {
          '201': { description: 'Created' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      };
    }

    // Item endpoints
    paths[`${objectPath}/{id}`] = {};

    if (shouldInclude('get')) {
      paths[`${objectPath}/{id}`].get = {
        summary: `Get ${name} by ID`,
        tags: [name],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Success' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      };
    }

    if (shouldInclude('update')) {
      paths[`${objectPath}/{id}`].put = {
        summary: `Update ${name}`,
        tags: [name],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${name}` },
            },
          },
        },
        responses: {
          '200': { description: 'Updated' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      };
    }

    if (shouldInclude('delete')) {
      paths[`${objectPath}/{id}`].delete = {
        summary: `Delete ${name}`,
        tags: [name],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': { description: 'Deleted' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      };
    }
  }

  return paths;
}

/**
 * Setup Swagger UI (optional peer dependency)
 */
export function setupSwaggerUI(
  app: SwaggerApp,
  spec: OpenAPISpec,
  path = '/docs',
) {
  try {
    const swaggerUi = require('swagger-ui-express');

    app.use(path, swaggerUi.serve);
    app.get(
      path,
      swaggerUi.setup(spec, {
        customCss: '.swagger-ui .topbar { display: none }',
      }),
    );

    app.get(
      `${path}/openapi.json`,
      (_req: unknown, res: { json(body: unknown): void }) => {
        res.json(spec);
      },
    );

    console.log(`📚 Swagger UI available at ${path}`);
  } catch (_error) {
    console.warn('Swagger UI not available (install swagger-ui-express)');
  }
}

function pluralize(word: string): string {
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  if (
    word.endsWith('s') ||
    word.endsWith('x') ||
    word.endsWith('z') ||
    word.endsWith('ch') ||
    word.endsWith('sh')
  )
    return `${word}es`;
  return `${word}s`;
}
