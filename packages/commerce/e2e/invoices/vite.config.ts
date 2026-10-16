import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { moneyFixture, retainedMoney } from './fixture.js';

export default defineConfig({
  plugins: [
    svelte({ emitCss: false }),
    {
      name: 'invoice-native-proof',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (url.pathname === '/tax-summary-report.json') {
            if (url.searchParams.get('state') === 'error') {
              response.statusCode = 503;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: 'Tax summary source unavailable' }));
              return;
            }
            const state = url.searchParams.get('state') === 'empty' || url.searchParams.get('state') === 'unknown'
              ? url.searchParams.get('state')
              : 'data';
            const { readTaxSummaryBrowserFixture } = await server.ssrLoadModule('/e2e/invoices/tax-summary-browser-server.ts');
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(await readTaxSummaryBrowserFixture(state)));
            return;
          }
          if (url.pathname === '/tax-summary-drilldown.json') {
            const { drilldownTaxSummaryBrowserFixture } = await server.ssrLoadModule('/e2e/invoices/tax-summary-browser-server.ts');
            try {
              const facts = await drilldownTaxSummaryBrowserFixture(
                url.searchParams.get('reportId') ?? '',
                url.searchParams.get('tenant') ?? '',
              );
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify(facts));
            } catch (error) {
              response.statusCode = 403;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Tax summary drilldown failed.' }));
            }
            return;
          }
          if (!['/native-money', '/save-money'].includes(url.pathname)) return next();
          const moneyCase = (url.searchParams.get('case') ?? 'A') as 'A' | 'B' | 'C' | 'D' | 'E';
          const moneyScope = url.searchParams.get('scope') === 'document' ? 'document' : 'line';
          try {
            const { page } = await server.ssrLoadModule('/e2e/invoices/ssr.ts');
            let props = { money: moneyFixture(moneyCase, moneyScope), action: '/save-money' };
            if (request.method === 'POST') {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const data = new URLSearchParams(Buffer.concat(chunks).toString());
              props = { money: retainedMoney(data, moneyCase, moneyScope), action: '/save-money' };
              response.statusCode = 422;
            }
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(page(props));
          } catch (error) { next(error as Error); }
        });
      },
    },
  ],
  ssr: { noExternal: ['@happyvertical/smrt-ui'] },
  server: { fs: { allow: ['../..'] } },
});
