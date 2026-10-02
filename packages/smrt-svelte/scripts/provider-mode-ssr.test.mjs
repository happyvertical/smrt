import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

test('Provider server rendering keeps voice off and never detects browser capabilities', async () => {
  const server = await createServer({
    configFile: 'e2e/vite.config.ts',
    server: { middlewareMode: true },
  });
  try {
    const { default: Harness } = await server.ssrLoadModule(
      resolve('src/__tests__/provider-mode-harness.svelte'),
    );
    const { render } = await server.ssrLoadModule('svelte/server');
    for (const props of [{}, { mode: 'default', autoEnableSmrt: true }]) {
      let manager;
      const result = await render(Harness, {
        props: { ...props, capture: (state) => { manager = state; } },
      });
      assert.equal(typeof window, 'undefined');
      assert.equal(manager.state.mode, 'default');
      assert.equal(manager.state.capabilities, null);
      assert.match(result.body, /default/);
    }
  } finally {
    await server.close();
  }
});
