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
  AdvisorRichProduct,
} from '../../__tests__/fixtures/advisor-test-classes.js';
import { previewApiEndpoints } from './preview-api-endpoints.js';

void AdvisorExcludeNote;
void AdvisorRichProduct;

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
      'curl -X POST "http://localhost:3000/api/v1/advisorrichproducts" -H "Content-Type: application/json" -d \'{"title":"example-title","quantity":1,"rate":9.99}\'',
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
      'http://localhost:3000/api/v1/advisorrichproducts?',
    );
    expect(list?.example).toContain('limit=25');
    expect(list?.example).toContain('title=example-title');
    expect(result.markdown).toContain('| title | query | text | no |');
  });

  it('respects a custom base path', async () => {
    const result = await previewApiEndpoints({
      className: 'AdvisorExcludeNote',
      basePath: '/v2',
    });
    expect(result.basePath).toBe('/v2');
    expect(result.endpoints.every((e) => e.path.startsWith('/v2/'))).toBe(true);
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
