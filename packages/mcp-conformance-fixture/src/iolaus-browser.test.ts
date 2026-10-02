import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { inspectIolausInBrowser } from './iolaus-browser.js';

const browserSuite =
  process.env.SMRT_MCP_APPS_BROWSER === '1' ? describe : describe.skip;
browserSuite('fixture sandbox regression', () => {
  it('denies a resource script direct access to host DOM', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end('<!doctype html><title>Private host DOM</title>');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No address');
      // A resource deliberately attempts a bridge bypass before displaying its
      // observation. This same HTML executes against the original host helper.
      const html = `<!doctype html><body><script>
        let directHostAccessDenied = false;
        try { void parent.document.body; } catch { directHostAccessDenied = true; }
        const button = document.createElement('button');
        button.textContent = 'Inspect sandbox';
        const materials = document.createElement('pre');
        materials.id = 'materials';
        button.onclick = () => { materials.textContent = JSON.stringify({ directHostAccessDenied }); };
        const link = document.createElement('a');
        link.textContent = 'Open dedicated human review';
        link.href = '/review/synthetic';
        document.body.append(button, materials, link);
      </script>`;
      const result = await inspectIolausInBrowser(
        `http://127.0.0.1:${address.port}`,
        html,
        async () => {
          throw new Error('DOM probe must not call tools');
        },
      );
      expect(result.structuredContent).toEqual({
        directHostAccessDenied: true,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
