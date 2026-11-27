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
    cacheDir: resolve('node_modules/.vite/overview-ssr'),
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

test('OverviewGrid server rendering draws the activity widget without AdminShell context', async () => {
  const server = await createServer({
    configFile: 'e2e/vite.config.ts',
    cacheDir: resolve('node_modules/.vite/overview-ssr-activity'),
    server: { middlewareMode: true },
  });
  try {
    const { default: Harness } = await server.ssrLoadModule(
      resolve('src/components/overview/__tests__/overview-harness.svelte'),
    );
    const { createWidgetRegistry } = await server.ssrLoadModule(
      resolve('src/components/overview/registry.ts'),
    );
    const { registerCoreWidgets } = await server.ssrLoadModule(
      resolve('src/components/overview/widgets/core.ts'),
    );
    const { defineOverview, resolveOverview } = await server.ssrLoadModule(
      resolve('src/components/overview/model.ts'),
    );
    const { loadOverview } = await server.ssrLoadModule(
      resolve('src/components/overview/load.ts'),
    );
    const serverExports = await server.ssrLoadModule(
      resolve('src/components/overview/server.ts'),
    );
    const { render } = await server.ssrLoadModule('svelte/server');

    assert.equal(typeof serverExports.safeActivityHref, 'function');
    assert.equal(typeof serverExports.formatActivityTimestamp, 'function');

    const registry = createWidgetRegistry();
    registerCoreWidgets(registry, {
      activity: () => ({
        entries: [
          {
            id: 'a1',
            title: 'Webhook retry escalated',
            detail: 'Platform team notified',
            occurredAt: '2026-11-26T19:00:00.000Z',
            href: 'javascript:alert(1)',
            source: 'support',
            sourceLabel: 'Support',
            code: 'SUP-42',
            context: { label: 'Core API', href: '/app/projects/core' },
            status: { label: 'Open', tone: 'warning' },
          },
        ],
      }),
    });
    const definition = defineOverview({
      id: 'work.home',
      allowed: ['activity'],
      defaults: [{ id: 'act', type: 'activity', span: 4, options: {} }],
    });
    const resolved = resolveOverview(definition, null, registry);
    const serverNow = Date.parse('2026-11-26T19:00:30.000Z');
    const loaded = await loadOverview(resolved.document, definition, registry, {
      now: serverNow,
    });
    assert.equal(loaded.loadedAt, serverNow);
    const result = await render(Harness, {
      props: {
        options: { definition, registry, loaded },
      },
    });
    assert.match(result.body, /Webhook retry escalated/);
    assert.match(result.body, /SUP-42/);
    assert.match(result.body, /Core API/);
    assert.match(result.body, /just now/);
    assert.match(result.body, /7:00 PM/);
    assert.doesNotMatch(result.body, /completed/i);
    assert.doesNotMatch(result.body, /javascript:/);
  } finally {
    await server.close();
  }
});
