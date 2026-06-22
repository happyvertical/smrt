/**
 * Coverage for the OpenAPI/Swagger spec generator output (#1500).
 *
 * generator-surface-hardening.spec asserts the `api: false` skip. This file
 * asserts the produced spec artifact in detail: config overrides, the
 * per-verb include/exclude path gating, the component schema shape (base
 * fields, required, the `*List` wrapper), every field-type → OpenAPI mapping,
 * pluralization branches, and the optional Swagger UI setup fallback.
 */

import { describe, expect, it } from 'vitest';

import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { generateOpenAPISpec, setupSwaggerUI } from './swagger';

function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// Exercises every fieldToOpenAPISchema branch + required propagation.
@smrt()
class SwaggerFieldWidget extends SmrtObject {
  @field({ type: 'text', required: true, maxLength: 120, minLength: 2 })
  title = '';

  @field({ type: 'integer', min: 0, max: 100 })
  count = 0;

  @field({ type: 'decimal', min: 1, max: 9.5 })
  rating = 0.0;

  @field({ type: 'boolean' })
  active = false;

  @field({ type: 'datetime', nullable: true })
  publishedAt: string | null = null;

  @field({ type: 'json' })
  meta: Record<string, any> = {};

  @field({ type: 'text', default: 'draft' })
  status = 'draft';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

// include list — only list+get paths should be emitted.
@smrt({ api: { include: ['list', 'get'] } })
class SwaggerReadOnly extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

// exclude list — delete path must be omitted; others present.
@smrt({ api: { exclude: ['delete'] } })
class SwaggerNoDelete extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

describe('OpenAPI spec generation (#1500)', () => {
  describe('top-level config', () => {
    it('uses defaults when no config is given', () => {
      const spec = generateOpenAPISpec();
      expect(spec.openapi).toBe('3.0.3');
      expect(spec.info.title).toBe('smrt API');
      expect(spec.info.version).toBe('1.0.0');
      expect(spec.servers[0].url).toBe('http://localhost:3000');
      // Bearer auth security scheme is always declared.
      expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
      expect(spec.security).toEqual([{ bearerAuth: [] }]);
      // Shared responses are present.
      expect(spec.components.responses.ValidationError).toBeDefined();
      expect(spec.components.responses.NotFound).toBeDefined();
    });

    it('honors title / version / description / serverUrl / basePath overrides', () => {
      const spec = generateOpenAPISpec({
        title: 'My API',
        version: '9.9.9',
        description: 'custom',
        serverUrl: 'https://api.example.com',
        basePath: '/v2',
      });
      expect(spec.info.title).toBe('My API');
      expect(spec.info.version).toBe('9.9.9');
      expect(spec.info.description).toBe('custom');
      expect(spec.servers[0].url).toBe('https://api.example.com');
      // Paths reflect the custom basePath.
      const keys = Object.keys(spec.paths);
      expect(keys.some((k) => k.startsWith('/v2/'))).toBe(true);
    });
  });

  describe('component schemas', () => {
    it('emits a base schema and a *List wrapper for a registered object', () => {
      const spec = generateOpenAPISpec();
      const schema = spec.components.schemas.SwaggerFieldWidget;
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');

      // Base framework fields are always present.
      expect(schema.properties.id).toEqual({ type: 'string', format: 'uuid' });
      expect(schema.properties.slug).toEqual({ type: 'string' });
      expect(schema.properties.created_at.format).toBe('date-time');
      expect(schema.properties.updated_at.format).toBe('date-time');

      // id is always required; a `required: true` field is added to required.
      expect(schema.required).toContain('id');
      expect(schema.required).toContain('title');

      // List wrapper shape.
      const list = spec.components.schemas.SwaggerFieldWidgetList;
      expect(list.properties.data.type).toBe('array');
      expect(list.properties.data.items.$ref).toBe(
        '#/components/schemas/SwaggerFieldWidget',
      );
      expect(list.properties.meta.properties.total.type).toBe('integer');
    });

    it('maps every field type to the right OpenAPI schema', () => {
      const spec = generateOpenAPISpec();
      const props = spec.components.schemas.SwaggerFieldWidget.properties;

      // text with length constraints
      expect(props.title.type).toBe('string');
      expect(props.title.maxLength).toBe(120);
      expect(props.title.minLength).toBe(2);

      // integer with min/max
      expect(props.count.type).toBe('integer');
      expect(props.count.minimum).toBe(0);
      expect(props.count.maximum).toBe(100);

      // decimal → number with float format + min/max
      expect(props.rating.type).toBe('number');
      expect(props.rating.format).toBe('float');
      expect(props.rating.minimum).toBe(1);
      expect(props.rating.maximum).toBe(9.5);

      // boolean
      expect(props.active.type).toBe('boolean');

      // datetime → string/date-time
      expect(props.publishedAt.type).toBe('string');
      expect(props.publishedAt.format).toBe('date-time');

      // json → object + additionalProperties
      expect(props.meta.type).toBe('object');
      expect(props.meta.additionalProperties).toBe(true);

      // default value carried through
      expect(props.status.default).toBe('draft');
    });
  });

  describe('path generation per verb', () => {
    it('emits collection + item CRUD paths with the expected operations', () => {
      const spec = generateOpenAPISpec();
      const base = '/api/v1/swaggerfieldwidgets';
      expect(spec.paths[base].get.summary).toContain('List');
      expect(spec.paths[base].post.summary).toContain('Create');
      expect(spec.paths[base].post.responses['201']).toBeDefined();
      expect(spec.paths[`${base}/{id}`].get).toBeDefined();
      expect(spec.paths[`${base}/{id}`].put).toBeDefined();
      expect(spec.paths[`${base}/{id}`].delete).toBeDefined();
      // List parameters include limit/offset.
      const paramNames = spec.paths[base].get.parameters.map(
        (p: any) => p.name,
      );
      expect(paramNames).toEqual(['limit', 'offset']);
    });

    it('include: [list, get] emits only those operations', () => {
      const spec = generateOpenAPISpec();
      const base = '/api/v1/swaggerreadonlies';
      expect(spec.paths[base].get).toBeDefined();
      // create not in include → no POST.
      expect(spec.paths[base].post).toBeUndefined();
      expect(spec.paths[`${base}/{id}`].get).toBeDefined();
      // update/delete not in include.
      expect(spec.paths[`${base}/{id}`].put).toBeUndefined();
      expect(spec.paths[`${base}/{id}`].delete).toBeUndefined();
    });

    it('exclude: [delete] omits the DELETE operation only', () => {
      const spec = generateOpenAPISpec();
      const base = '/api/v1/swaggernodeletes';
      expect(spec.paths[base].get).toBeDefined();
      expect(spec.paths[base].post).toBeDefined();
      expect(spec.paths[`${base}/{id}`].get).toBeDefined();
      expect(spec.paths[`${base}/{id}`].put).toBeDefined();
      // delete excluded.
      expect(spec.paths[`${base}/{id}`].delete).toBeUndefined();
    });
  });

  describe('setupSwaggerUI fallback', () => {
    it('warns instead of throwing when swagger-ui-express is unavailable', () => {
      const original = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        // `app` is never used because the require() of the optional peer dep
        // throws first and is caught. Must not throw.
        expect(() => setupSwaggerUI({}, generateOpenAPISpec())).not.toThrow();
      } finally {
        console.warn = original;
      }
      expect(warnings.some((w) => w.includes('Swagger UI not available'))).toBe(
        true,
      );
    });
  });
});

// Pluralization branch coverage: names ending in y / x / z / ch / sh / default.
@smrt()
class SwaggerCategory extends SmrtObject {
  // ends in 'y' → categories
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

@smrt()
class SwaggerBox extends SmrtObject {
  // ends in 'x' → boxes
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

@smrt()
class SwaggerBuzz extends SmrtObject {
  // ends in 'z' → buzzes
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

@smrt()
class SwaggerDish extends SmrtObject {
  // ends in 'sh' → dishes
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

describe('OpenAPI pluralization branches (#1500)', () => {
  it('pluralizes y/x/z/sh/default endings in the path keys', () => {
    const spec = generateOpenAPISpec();
    const keys = Object.keys(spec.paths);
    expect(keys).toContain('/api/v1/swaggercategories'); // y → ies
    expect(keys).toContain('/api/v1/swaggerboxes'); // x → xes
    expect(keys).toContain('/api/v1/swaggerbuzzes'); // z → zes
    expect(keys).toContain('/api/v1/swaggerdishes'); // sh → shes
    // default 's' suffix is exercised by SwaggerFieldWidget → ...widgets.
    expect(keys).toContain('/api/v1/swaggerfieldwidgets');
  });
});
