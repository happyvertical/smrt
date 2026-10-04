import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [svelte(), {
    name: 'expense-native-proof',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const review = request.url === '/native-review' || (request.url === '/e2e/index.html?review=1' && request.method === 'POST');
        if (!review && request.url !== '/native' && request.url !== '/save') return next();
        try {
          const { page, reviewPage } = await server.ssrLoadModule('/e2e/ssr.ts');
          let props = {};
          if (request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const data = new URLSearchParams(Buffer.concat(chunks).toString());
            props = { values: Object.fromEntries(data), message: 'Expense denied; entries retained', errors: { amount: 'Check amount' }, hiddenFields: ['requestId', 'tenantId', 'predecessorId'].map(name => ({ name, value: data.get(name) ?? '' })) };
            response.statusCode = 422;
          }
          response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(review ? await reviewPage(request.method === 'POST' ? 'Review denied; request retained' : '') : page(props));
        } catch (error) { next(error as Error); }
      });
    },
  }],
  ssr: { noExternal: ['@happyvertical/smrt-ui'] }, server: { fs: { allow: ['../..'] } },
});
