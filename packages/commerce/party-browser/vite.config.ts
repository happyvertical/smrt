import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

function nativeFormTestServer(): Plugin {
  return {
    name: 'native-party-form-test-server',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url === '/native') {
          const module = await server.ssrLoadModule('/native-page.ts');
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(module.renderNativePage());
          return;
        }
        if (request.url === '/native-vendor') {
          const module = await server.ssrLoadModule('/native-page.ts');
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(module.renderNativeVendorPage());
          return;
        }
        if (request.url === '/native-custom-actions') {
          const module = await server.ssrLoadModule('/native-page.ts');
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(module.renderNativeCustomActionsPage());
          return;
        }
        if (request.url === '/native-directories') {
          const module = await server.ssrLoadModule('/native-page.ts');
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(module.renderNativeDirectoriesPage());
          return;
        }
        if (request.url?.startsWith('/directory-search?')) {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end('<p id="search-complete">Search complete</p>');
          return;
        }
        if (request.url === '/party-submit' && request.method === 'POST') {
          let body = '';
          request.setEncoding('utf8');
          for await (const chunk of request) body += chunk;
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(`<pre id="payload">${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [svelte(), nativeFormTestServer()],
});
