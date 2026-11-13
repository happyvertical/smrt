import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateOpenAPISpec } from '../generators/swagger.js';
import { ObjectRegistry } from '../registry.js';
import {
  type RuntimeModelDefinition,
  registerRuntimeModel,
} from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

type WriteOperation = {
  requestBody: {
    content: { 'application/json': { schema: { $ref: string } } };
  };
};
interface Spec {
  components: {
    schemas: Record<string, { properties: Record<string, unknown> }>;
  };
  paths: Record<string, { post: WriteOperation; put: WriteOperation }>;
}

describe('generated OpenAPI input components #4972 round2 item4', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  for (const reverse of [false, true]) {
    it(`preserves real OrderInput models and chooses a deterministic collision-free write schema (reverse=${reverse})`, () => {
      const definitions: RuntimeModelDefinition[] = [
        {
          name: 'Order',
          packageName: '@test/openapi',
          fields: {
            qty: { type: 'integer' },
            total: { type: 'integer', generated: { col: 'qty' } },
          },
        },
        {
          name: 'OrderInput',
          packageName: '@test/openapi',
          fields: { marker: { type: 'text' } },
        },
        {
          name: 'OrderInput2',
          packageName: '@test/openapi',
          fields: { other: { type: 'text' } },
        },
      ];
      for (const def of reverse ? definitions.reverse() : definitions)
        registerRuntimeModel(def);
      const spec = generateOpenAPISpec({
        basePath: '/compat',
      }) as unknown as Spec;
      expect(spec.components.schemas.OrderInput.properties).toHaveProperty(
        'marker',
      );
      expect(spec.components.schemas.OrderInput.properties).not.toHaveProperty(
        'qty',
      );
      expect(spec.components.schemas.OrderInput2.properties).toHaveProperty(
        'other',
      );
      expect(spec.components.schemas.Order.properties).toHaveProperty('total');
      expect(spec.components.schemas.OrderInput3.properties).toHaveProperty(
        'qty',
      );
      expect(spec.components.schemas.OrderInput3.properties).not.toHaveProperty(
        'total',
      );
      expect(
        spec.paths['/compat/orders'].post.requestBody.content[
          'application/json'
        ].schema.$ref,
      ).toBe('#/components/schemas/OrderInput3');
      expect(
        spec.paths['/compat/orders/{id}'].put.requestBody.content[
          'application/json'
        ].schema.$ref,
      ).toBe('#/components/schemas/OrderInput3');
      expect(spec.components.schemas).not.toHaveProperty('OrderInputInput');
      expect(spec.components.schemas).not.toHaveProperty('OrderInput2Input');
    });
  }
});
