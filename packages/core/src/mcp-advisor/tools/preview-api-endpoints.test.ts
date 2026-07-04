/**
 * Tests for the mcp-advisor preview-api-endpoints tool.
 *
 * Registry-backed: imported @smrt() fixtures supply api config and fields. Covers
 * include lists (with a custom action), exclude lists, the default base path,
 * a custom base path, and field-derived body parameters.
 */

import { describe, expect, it } from 'vitest';
import {
  AdvisorExcludeNote,
  AdvisorPolicyRecord,
  AdvisorRichProduct,
} from '../../__tests__/fixtures/advisor-test-classes.js';
import { previewApiEndpoints } from './preview-api-endpoints.js';

void AdvisorExcludeNote;
void AdvisorPolicyRecord;
void AdvisorRichProduct;

const EXAMPLE_UUID = '00000000-0000-4000-8000-000000000001';

describe('mcp-advisor: previewApiEndpoints', () => {
  it('generates endpoints honouring an include list plus custom actions', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorRichProduct',
    });

    expect(result.basePath).toBe('/api/v1');
    const byKey = result.endpoints.map((e) => `${e.method} ${e.path}`);

    // Standard CRUD from the include list.
    expect(byKey).toContain('GET /api/v1/advisorrichproducts');
    expect(byKey).toContain('GET /api/v1/advisorrichproducts/:id');
    expect(byKey).toContain('POST /api/v1/advisorrichproducts');
    expect(byKey).toContain('PUT /api/v1/advisorrichproducts/:id');
    // 'delete' was not in the include list → no DELETE endpoint.
    expect(byKey).not.toContain('DELETE /api/v1/advisorrichproducts/:id');
    // The custom 'archive' action becomes a POST sub-resource endpoint.
    expect(byKey).toContain('POST /api/v1/advisorrichproducts/:id/archive');

    // CREATE endpoint body params are derived from the registered fields.
    const create = result.endpoints.find(
      (e) => e.method === 'POST' && e.path === '/api/v1/advisorrichproducts',
    );
    const titleParam = create?.parameters?.find((p) => p.name === 'title');
    expect(titleParam).toMatchObject({
      description: 'Product display name',
      example: 'example-title',
      location: 'body',
      required: true,
      type: 'text',
    });

    expect(create?.example).toBe(
      'curl -X POST "https://api.example.com/api/v1/advisorrichproducts" -H "Content-Type: application/json" -d \'{"title":"example-title","quantity":1,"rate":9.99}\'',
    );
    expect(result.markdown).toContain('## POST /api/v1/advisorrichproducts');
    expect(result.markdown).toContain('```bash\ncurl -X POST');
  });

  it('honours an exclude list (delete removed)', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorExcludeNote',
    });
    const byKey = result.endpoints.map((e) => `${e.method} ${e.path}`);

    // No include list → all standard endpoints except the excluded delete.
    expect(byKey).toContain('GET /api/v1/advisorexcludenotes');
    expect(byKey).toContain('POST /api/v1/advisorexcludenotes');
    expect(byKey).toContain('PUT /api/v1/advisorexcludenotes/:id');
    expect(byKey).not.toContain('DELETE /api/v1/advisorexcludenotes/:id');
  });

  it('includes query parameters and copyable examples for list endpoints', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorRichProduct',
    });

    const list = result.endpoints.find(
      (e) => e.method === 'GET' && e.path === '/api/v1/advisorrichproducts',
    );
    expect(list?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          example: 25,
          location: 'query',
          name: 'limit',
          type: 'integer',
        }),
        expect.objectContaining({
          example: 'example-title',
          location: 'query',
          name: 'title',
          type: 'text',
        }),
      ]),
    );
    expect(list?.parameters?.map((p) => p.name)).not.toContain('where');
    expect(list?.example).toContain(
      'https://api.example.com/api/v1/advisorrichproducts?',
    );
    expect(list?.example).toContain('limit=25');
    expect(list?.example).toContain('title=example-title');
    expect(result.markdown).toContain('| title | query | text | no |');
    expect(result.markdown).toContain('title[in]=value1,value2');
  });

  it('mirrors sensitive filter and writable body policies', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorPolicyRecord',
    });

    const list = result.endpoints.find(
      (e) => e.method === 'GET' && e.path === '/api/v1/advisorpolicyrecords',
    );
    const listParamNames = list?.parameters?.map((p) => p.name) ?? [];
    expect(listParamNames).toContain('displayName');
    expect(listParamNames).toContain('customerId');
    expect(listParamNames).toContain('externalId');
    expect(listParamNames).not.toContain('secretToken');
    expect(list?.example).not.toContain('secretToken');

    expect(
      list?.parameters?.find((p) => p.name === 'customerId')?.example,
    ).toBe(EXAMPLE_UUID);
    expect(
      list?.parameters?.find((p) => p.name === 'externalId')?.example,
    ).toBe(1);

    const create = result.endpoints.find(
      (e) => e.method === 'POST' && e.path === '/api/v1/advisorpolicyrecords',
    );
    const createParamNames = create?.parameters?.map((p) => p.name) ?? [];
    expect(createParamNames).toEqual([
      'displayName',
      'customerId',
      'externalId',
      'secretToken',
    ]);
    expect(create?.example).toContain(`"customerId":"${EXAMPLE_UUID}"`);
    expect(create?.example).toContain('"externalId":1');
    expect(create?.example).not.toContain('internalCode');
    expect(create?.example).not.toContain('tenantId');
    expect(create?.example).not.toContain('ignoredValue');

    const update = result.endpoints.find(
      (e) =>
        e.method === 'PUT' && e.path === '/api/v1/advisorpolicyrecords/:id',
    );
    const updateBodyParamNames =
      update?.parameters
        ?.filter((parameter) => parameter.location === 'body')
        .map((parameter) => parameter.name) ?? [];
    expect(updateBodyParamNames).toEqual(createParamNames);
  });

  it('respects a custom base path', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorExcludeNote',
      basePath: '/v2',
    });
    expect(result.basePath).toBe('/v2');
    expect(result.endpoints.every((e) => e.path.startsWith('/v2/'))).toBe(true);
  });

  it('uses a custom base URL for generated curl examples', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorExcludeNote',
      baseUrl: 'http://localhost:5173',
    });

    expect(result.endpoints[0]?.example).toContain(
      'http://localhost:5173/api/v1/advisorexcludenotes',
    );
  });

  it('returns the full default endpoint set for an unregistered class', async () => {
    // getConfig() yields {} for unknown classes, so every standard endpoint is
    // included (no include/exclude filtering) rather than throwing.
    const result = await previewApiEndpoints({ className: 'UnknownApiClass' });
    const methods = result.endpoints.map((e) => e.method).sort();
    expect(methods).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT']);
    expect(result.endpoints.every((e) => e.parameters)).toBe(true);
    expect(result.endpoints.every((e) => e.example)).toBe(true);
  });
});
