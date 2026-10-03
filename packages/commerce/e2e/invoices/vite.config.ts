import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte(), {
    name: 'invoice-native-proof',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/native' && request.url !== '/save') return next();
        try {
          const { page } = await server.ssrLoadModule('/e2e/invoices/ssr.ts');
          let props = {};
          if (request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const data = new URLSearchParams(Buffer.concat(chunks).toString());
            const amounts = data.getAll('allocationAmount');
            const rows = data.getAll('sourceId').map((sourceId, index) => ({ key: `row-${index}`, sourceId, amount: amounts[index] ?? '', remove: data.getAll('removeRow').includes(String(index)) }));
            const add = data.get('intent') === 'addAllocation';
            if (add) rows.push({ key: `row-${rows.length}`, sourceId: '', amount: '', remove: false });
            props = { allocations: rows, message: add ? undefined : 'Rejected by server; entries retained', hiddenFields: [{ name: 'requestId', value: data.get('requestId') ?? '' }, { name: 'tenantId', value: data.get('tenantId') ?? '' }] };
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
