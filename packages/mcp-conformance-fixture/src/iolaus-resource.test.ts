import { describe, expect, it } from 'vitest';
import { buildIolausResource } from './iolaus-resource.js';

describe('immutable resource host configuration', () => {
  it.each([
    '*',
    'null',
    'https://host.example/path',
    'https://user:pass@host.example',
    'http://host.example',
    'data:text/html,view',
  ])('rejects non-origin or unsafe configuration %s', async (origin) => {
    await expect(buildIolausResource(origin)).rejects.toThrow();
  });
});
