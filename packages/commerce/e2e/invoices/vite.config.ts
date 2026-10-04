import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { retainedValues } from './fixture.js';

export default defineConfig({
  plugins: [svelte({ emitCss: false }), {
    name: 'invoice-native-proof',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/native' && request.url !== '/save') return next();
        try {
          const { page } = await server.ssrLoadModule('/e2e/invoices/ssr.ts');
          const { calculateInvoiceDraft } = await server.ssrLoadModule('/src/svelte/invoices/calculations.ts');
          let props = {};
          if (request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const data = new URLSearchParams(Buffer.concat(chunks).toString());
            const amounts = data.getAll('allocationAmount');
            const rows = data.getAll('sourceId').map((sourceId, index) => ({ key: `row-${index}`, sourceId, amount: amounts[index] ?? '', remove: data.getAll('removeRow').includes(String(index)) }));
            const intent = String(data.get('intent') ?? '');
            const values = retainedValues(data);
            // Fixture policy independently supplies the authorized default. Posted totals are ignored.
            const authoritative = calculateInvoiceDraft({ ...values, taxRate: '5' });
            if (request.url === '/save' && request.headers.accept === 'application/json') {
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify(authoritative)); return;
            }
            if (intent === 'addLine') values.lines = [...values.lines, { key: `line-${values.lines.length}`, description: '', sku: '', quantity: '1', unitPrice: '', discountType: 'flat', discountValue: '0', taxMode: 'inherit', taxRate: '0' }];
            if (intent.startsWith('removeLine:')) values.lines = values.lines.filter(line => line.key !== intent.slice('removeLine:'.length));
            const add = intent === 'addAllocation';
            if (add) rows.push({ key: `row-${rows.length}`, sourceId: '', amount: '', remove: false });
            props = { values, allocations: rows, message: add || intent === 'addLine' || intent.startsWith('removeLine:') ? undefined : 'Rejected by server; entries retained', hiddenFields: [{ name: 'requestId', value: data.get('requestId') ?? '' }, { name: 'tenantId', value: data.get('tenantId') ?? '' }] };
            response.statusCode = add ? 200 : 422;
          }
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(page(props));
        } catch (error) { next(error as Error); }
      });
    },
  }],
  ssr: { noExternal: ['@happyvertical/smrt-ui'] },
  server: { fs: { allow: ['../..'] } },
});
