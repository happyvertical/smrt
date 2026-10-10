import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

// The overview surface must render fully on the server from the page's loaded
// data (#3727): no loading placeholders, no client-only fetch, sanitized
// content. A client render of the same props is covered in the vitest suite.
test('OverviewGrid server rendering draws every widget from loaded data', async () => {
  const server = await createServer({
    configFile: 'e2e/vite.config.ts',
    server: { middlewareMode: true },
  });
  try {
    const { default: Harness } = await server.ssrLoadModule(
      resolve('src/components/overview/__tests__/overview-harness.svelte'),
    );
    const fixtures = await server.ssrLoadModule(
      resolve('src/components/overview/__tests__/app-fixtures.ts'),
    );
    const { render } = await server.ssrLoadModule('svelte/server');
    const registry = fixtures.coreRegistry();
    const loaded = await fixtures.loadedFor(registry);
    let fetched = 0;
    const result = await render(Harness, {
      props: {
        options: {
          definition: fixtures.definition,
          registry,
          loaded,
          loadWidget: async () => {
            fetched += 1;
            return {};
          },
        },
      },
    });
    assert.equal(typeof window, 'undefined');
    assert.equal(fetched, 0);
    assert.match(result.body, /42/);
    assert.match(result.body, /Spring gala/);
    assert.match(result.body, /<strong[^>]*>[^<]*(?:<!--[^>]*-->)*Hi/);
    assert.doesNotMatch(result.body, /Loading/);
    assert.doesNotMatch(result.body, /javascript:/);
    assert.deepEqual(
      [...result.body.matchAll(/data-span="(\d)"/g)].map((m) => m[1]),
      ['1', '2', '1', '2'],
    );
  } finally {
    await server.close();
  }
});
