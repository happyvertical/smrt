import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [svelte(), {
    name: 'attachment-native-proof',
    configureServer(server) {
      let proof: Record<string, unknown> = {};
      server.middlewares.use(async (request, response, next) => {
        if (request.url === '/proof') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(proof)); return; }
        if (request.url !== '/native' && request.url !== '/upload') return next();
        try {
          const { page } = await server.ssrLoadModule('/e2e/attachments/ssr.ts');
          let props = {};
          if (request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const posted = new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) });
            const data = await posted.formData();
            const file = data.get('receipt');
            proof = { filename: file instanceof File ? file.name : null, bytes: file instanceof File ? await file.text() : null, requestId: data.get('requestId'), tenantId: data.get('tenantId'), intent: data.get('intent') };
            props = { description: String(data.get('description') ?? ''), message: 'Upload rejected; metadata retained', reselectFile: true, fileError: 'Choose an allowed document', hiddenFields: [{ name: 'requestId', value: String(data.get('requestId') ?? '') }, { name: 'tenantId', value: String(data.get('tenantId') ?? '') }] };
            response.statusCode = 422;
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
