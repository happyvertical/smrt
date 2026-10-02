import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { chromium } from '@playwright/test';

/** Only the host peer is synthetic; the bridge, browser and SDK HTTP call are real. */
export async function inspectIolausInBrowser(
  origin: string,
  html: string,
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.exposeFunction('syntheticTool', call);
    await page.goto(`${origin}/ui`);
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    if (!script) throw new Error('Missing declared resource script');
    const csp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
    await page.evaluate(
      ({ html, csp }) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('csp', csp);
        // Opaque sandbox denies direct access to the same-origin synthetic host.
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.srcdoc = html;
        iframe.title = 'Synthetic Iolaus';
        document.body.append(iframe);
        window.addEventListener('message', async (event) => {
          if (event.source !== iframe.contentWindow || event.origin !== 'null')
            return;
          const message = event.data;
          if (!message.method || !message.id) return;
          const reply = (envelope: Record<string, unknown>) =>
            iframe.contentWindow?.postMessage(
              { jsonrpc: '2.0', id: message.id, ...envelope },
              // Opaque sandboxed documents require '*' as the target origin;
              // the exact iframe window is still checked above.
              '*',
            );
          if (message.method === 'ui/initialize')
            reply({
              result: {
                protocolVersion: '2026-01-26',
                hostInfo: { name: 'synthetic-only', version: '1' },
                hostCapabilities: { serverTools: {} },
                hostContext: {},
              },
            });
          if (message.method === 'tools/call') {
            try {
              reply({
                result: await (
                  window as unknown as {
                    syntheticTool: (
                      name: string,
                      args: Record<string, unknown>,
                    ) => Promise<unknown>;
                  }
                ).syntheticTool(message.params.name, message.params.arguments),
              });
            } catch {
              reply({ error: { code: -32000, message: 'Unavailable' } });
            }
          }
        });
      },
      { html, csp },
    );
    const element = await page.waitForSelector('iframe');
    const frame = await element.contentFrame();
    if (!frame) throw new Error('Missing embedded frame');
    await frame.waitForLoadState();
    const directHostAccessDenied = await frame.evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    });
    if (!directHostAccessDenied)
      throw new Error('Sandboxed view accessed host DOM directly');
    await frame.getByRole('button').first().click();
    await frame.waitForFunction(() =>
      Boolean(document.getElementById('materials')?.textContent),
    );
    return {
      structuredContent: JSON.parse(
        await frame.locator('#materials').innerText(),
      ),
    };
  } finally {
    await browser.close();
  }
}
