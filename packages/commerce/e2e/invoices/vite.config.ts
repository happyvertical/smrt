import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import {
  invoiceRoundingValues,
  moneyFixture,
  retainedMoney,
  retainedValues,
} from './fixture.js';

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
          if (!['/native', '/save', '/native-invoice-rounding', '/save-invoice-rounding', '/native-money', '/save-money'].includes(url.pathname)) return next();
          const money = url.pathname.endsWith('-money');
          const moneyCase = (url.searchParams.get('case') ?? 'A') as 'A' | 'B' | 'C' | 'D' | 'E';
          const moneyScope = url.searchParams.get('scope') === 'document' ? 'document' : 'line';
          const invoiceRounding = url.pathname.endsWith('-invoice-rounding');
          const policy = invoiceRounding ? { roundingScope: 'invoice' as const, action: '/save-invoice-rounding' } : {};
          try {
            const { page } = await server.ssrLoadModule('/e2e/invoices/ssr.ts');
            const { calculateInvoiceDraft } = await server.ssrLoadModule('/src/svelte/invoices/calculations.ts');
            let props = money ? { money: moneyFixture(moneyCase, moneyScope), action: '/save-money' } : invoiceRounding ? { ...policy, values: invoiceRoundingValues } : {};
            if (request.method === 'POST') {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const data = new URLSearchParams(Buffer.concat(chunks).toString());
              if (money) {
                props = { money: retainedMoney(data, moneyCase, moneyScope), action: '/save-money' };
                response.statusCode = 422;
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end(page(props));
                return;
              }
              const amounts = data.getAll('allocationAmount');
              const rows = data.getAll('sourceId').map((sourceId, index) => ({ key: `row-${index}`, sourceId, amount: amounts[index] ?? '', remove: data.getAll('removeRow').includes(String(index)) }));
              const intent = String(data.get('intent') ?? '');
              const values = retainedValues(data);
              const authoritative = calculateInvoiceDraft({ ...values, taxRate: '5' }, policy);
              if (url.pathname.startsWith('/save') && request.headers.accept === 'application/json') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(authoritative));
                return;
              }
              if (intent === 'addLine') values.lines = [...values.lines, { key: `line-${values.lines.length}`, description: '', sku: '', quantity: '1', unitPrice: '', discountType: 'flat', discountValue: '0', taxMode: 'inherit', taxRate: '0' }];
              if (intent.startsWith('removeLine:')) values.lines = values.lines.filter(line => line.key !== intent.slice('removeLine:'.length));
              const add = intent === 'addAllocation';
              if (add) rows.push({ key: `row-${rows.length}`, sourceId: '', amount: '', remove: false });
              props = { ...policy, values, allocations: rows, message: add || intent === 'addLine' || intent.startsWith('removeLine:') ? undefined : 'Rejected by server; entries retained', hiddenFields: [{ name: 'requestId', value: data.get('requestId') ?? '' }, { name: 'tenantId', value: data.get('tenantId') ?? '' }] };
              response.statusCode = add ? 200 : 422;
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
