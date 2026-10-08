import { build } from 'vite';
const banned = /^(node:|pg$|@happyvertical\/(pdf|ocr|speech|ai)$)/;
await build({
  configFile: false,
  logLevel: 'error',
  plugins: [{ name: 'ingestion-browser-boundary', resolveId(id) { if (banned.test(id)) throw new Error(`Server dependency in browser graph: ${id}`); } }],
  build: { write: false, lib: { entry: ['dist/index.js', 'dist/dto.js'], formats: ['es'] }, minify: false },
  resolve: { conditions: ['browser', 'import', 'default'] },
});
