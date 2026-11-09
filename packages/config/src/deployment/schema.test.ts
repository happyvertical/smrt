import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  validateComposeDeployment,
  X_HAPPYVERTICAL_BINDINGS,
  X_HAPPYVERTICAL_PRESETS,
  X_HAPPYVERTICAL_ROLES,
  X_HAPPYVERTICAL_SCHEMA_ID,
  X_HAPPYVERTICAL_VERSION,
} from './compose-contract.js';

type Doc = Record<string, any>;

const schema = JSON.parse(
  readFileSync(
    new URL('../../schemas/x-happyvertical.v1.schema.json', import.meta.url),
    'utf8',
  ),
);
const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function stack(): Doc {
  return {
    'x-happyvertical': {
      version: 1,
      preset: 'smrt',
      domain: 'app.example.com',
      migrate: { service: 'web', command: ['pnpm', 'exec', 'smrt', 'migrate'] },
    },
    services: {
      web: {
        image: 'ghcr.io/acme/web:dev',
        ports: ['3000:3000'],
        'x-happyvertical': { role: 'web', health: { path: '/health' } },
      },
      worker: {
        image: 'ghcr.io/acme/worker:dev',
        'x-happyvertical': {
          role: 'worker',
          health: { command: ['node', 'check.js'] },
        },
      },
      database: {
        image: 'postgres:18-alpine',
        'x-happyvertical': { binding: 'postgres' },
      },
      adminer: { image: 'adminer' },
    },
  };
}

describe('published x-happyvertical v1 JSON Schema', () => {
  it('is published with the package under a versioned name', () => {
    expect(manifest.files).toContain('schemas');
    expect(manifest.exports['./schemas/*']).toBe('./schemas/*');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(X_HAPPYVERTICAL_SCHEMA_ID);
    expect(schema.$id).toContain(`/v${X_HAPPYVERTICAL_VERSION}.`);
  });

  it('names the same version, presets, roles and bindings as the validator', () => {
    const { application, service } = schema.$defs;
    expect(application.properties.version.const).toBe(X_HAPPYVERTICAL_VERSION);
    expect(application.properties.preset.enum).toEqual([
      ...X_HAPPYVERTICAL_PRESETS,
    ]);
    expect(service.properties.role.enum).toEqual([...X_HAPPYVERTICAL_ROLES]);
    expect(service.properties.binding.enum).toEqual([
      ...X_HAPPYVERTICAL_BINDINGS,
    ]);
  });

  it('avoids regular-expression lookarounds so RE2-based consumers can load it', () => {
    expect(JSON.stringify(schema)).not.toMatch(/\(\?[=!<]/);
  });

  it('accepts a valid declaration that the validator also accepts', () => {
    expect(validateSchema(stack())).toBe(true);
    expect(validateComposeDeployment(stack()).errors).toEqual([]);
  });

  // Every annotation shape error is refused by both the schema and the
  // validator, so a consumer that only loads the schema fails the same files.
  const shapeErrors: Array<[string, (doc: Doc) => void]> = [
    ['no contract block', (doc) => delete doc['x-happyvertical']],
    ['no services', (doc) => delete doc.services],
    ['version 2', (doc) => (doc['x-happyvertical'].version = 2)],
    ['version as text', (doc) => (doc['x-happyvertical'].version = '1')],
    ['no version', (doc) => delete doc['x-happyvertical'].version],
    ['unknown preset', (doc) => (doc['x-happyvertical'].preset = 'rails')],
    ['no preset', (doc) => delete doc['x-happyvertical'].preset],
    ['unknown field', (doc) => (doc['x-happyvertical'].tier = 'T2')],
    [
      'domain with a scheme',
      (doc) => (doc['x-happyvertical'].domain = 'https://app.example.com'),
    ],
    [
      'domain with a port',
      (doc) => (doc['x-happyvertical'].domain = 'app.example.com:443'),
    ],
    [
      'single-label domain',
      (doc) => (doc['x-happyvertical'].domain = 'localhost'),
    ],
    ['no migrate', (doc) => delete doc['x-happyvertical'].migrate],
    [
      'migrate command as text',
      (doc) => (doc['x-happyvertical'].migrate.command = 'pnpm migrate'),
    ],
    [
      'variable in the migrate command',
      (doc) => (doc['x-happyvertical'].migrate.command = ['pnpm', '$TASK']),
    ],
    [
      'variable in the health path',
      (doc) => (doc.services.web['x-happyvertical'].health.path = '/${P}'),
    ],
    [
      'variable in a health command',
      (doc) =>
        (doc.services.worker['x-happyvertical'].health.command = [
          'check',
          '$MODE',
        ]),
    ],
    [
      'empty argument in the migrate command',
      (doc) => (doc['x-happyvertical'].migrate.command = ['pnpm', '']),
    ],
    [
      'empty migrate command',
      (doc) => (doc['x-happyvertical'].migrate.command = []),
    ],
    [
      'unknown migrate field',
      (doc) => (doc['x-happyvertical'].migrate.image = 'x'),
    ],
    [
      'role and binding together',
      (doc) => (doc.services.worker['x-happyvertical'].binding = 'ai'),
    ],
    [
      'unknown role',
      (doc) => (doc.services.worker['x-happyvertical'].role = 'cron'),
    ],
    [
      'unknown binding',
      (doc) => (doc.services.database['x-happyvertical'].binding = 'mysql'),
    ],
    [
      'role without health',
      (doc) => delete doc.services.web['x-happyvertical'].health,
    ],
    [
      'health with path and command',
      (doc) => (doc.services.web['x-happyvertical'].health.command = ['true']),
    ],
    [
      'empty health',
      (doc) => (doc.services.web['x-happyvertical'].health = {}),
    ],
    [
      'relative health path',
      (doc) => (doc.services.web['x-happyvertical'].health.path = 'health'),
    ],
    [
      'worker with an HTTP health path',
      (doc) =>
        (doc.services.worker['x-happyvertical'].health = { path: '/health' }),
    ],
    [
      'binding with health',
      (doc) =>
        (doc.services.database['x-happyvertical'].health = {
          command: ['pg_isready'],
        }),
    ],
    [
      'empty annotation',
      (doc) => (doc.services.adminer['x-happyvertical'] = {}),
    ],
    [
      'unknown annotation field',
      (doc) => (doc.services.web['x-happyvertical'].replicas = 2),
    ],
  ];

  it.each(shapeErrors)('refuses %s in both', (_label, mutate) => {
    const doc = stack();
    mutate(doc);
    expect(validateSchema(doc)).toBe(false);
    expect(validateComposeDeployment(doc).ok).toBe(false);
  });

  it('exposes the application and service blocks as standalone definitions', () => {
    const application = ajv.compile({
      $ref: `${schema.$id}#/$defs/application`,
    });
    const service = ajv.compile({ $ref: `${schema.$id}#/$defs/service` });
    expect(application(stack()['x-happyvertical'])).toBe(true);
    expect(service({ binding: 'bucket' })).toBe(true);
    expect(service({ binding: 'bucket', role: 'web' })).toBe(false);
  });
});
