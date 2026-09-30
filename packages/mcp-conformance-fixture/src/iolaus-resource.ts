import { build } from 'vite';
/** Build once before declaration; the resource server never compiles on reads. */
export async function buildIolausResource() {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: true,
      lib: {
        entry: new URL('./iolaus-view.ts', import.meta.url).pathname,
        name: 'IolausView',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw new Error('Unexpected watch build');
  const script = output.output.find((item) => item.type === 'chunk');
  if (!script || script.type !== 'chunk')
    throw new Error('Missing Iolaus bundle');
  return `<!doctype html><html lang="en"><head><title>Synthetic Iolaus review</title></head><body><h1>Synthetic human review materials</h1><script>${script.code}</script></body></html>`;
}
