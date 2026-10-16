import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';

const localPackages = [
  { variable: 'SMRT_CORE_LOCAL', name: '@happyvertical/smrt-core' },
  { variable: 'SMRT_SVELTE_LOCAL', name: '@happyvertical/smrt-svelte' },
  { variable: 'SMRT_UI_LOCAL', name: '@happyvertical/smrt-ui' },
];
const localAliases = (
  await Promise.all(
    localPackages.map(async ({ variable, name }) => {
      const directory = process.env[variable];
      if (!directory) return [];
      const pkg = JSON.parse(
        await readFile(resolve(directory, 'package.json'), 'utf8'),
      ) as {
        name: string;
        exports: Record<string, { svelte?: string; import?: string }>;
      };
      if (pkg.name !== name)
        throw new Error(`${variable} must name the ${name} package directory.`);
      return Object.entries(pkg.exports).map(([subpath, entry]) => {
        const specifier = `${name}${subpath === '.' ? '' : subpath.slice(1)}`;
        return {
          find: new RegExp(`^${specifier.replaceAll('.', '\\.')}(?=\\?|$)`),
          replacement: resolve(directory, entry.svelte ?? entry.import ?? ''),
        };
      });
    }),
  )
).flat();

const result = await build({
  configFile: false,
  plugins: [svelte()],
  resolve: {
    alias: localAliases,
    dedupe: ['svelte', '@happyvertical/smrt-ui'],
  },
  build: {
    write: false,
    lib: {
      entry: 'src/mcp/main.ts',
      name: 'SmrtKitchenPlanner',
      formats: ['iife'],
    },
    cssCodeSplit: false,
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
  'output' in r ? r.output : [],
);
const code = outputs
  .filter((o) => o.type === 'chunk')
  .map((o) => o.code)
  .join('\n');
const css = outputs
  .flatMap((o) =>
    o.type === 'asset' && o.fileName.endsWith('.css') ? [o.source] : [],
  )
  .join('\n');
await mkdir('app', { recursive: true });
await writeFile(
  'app/mcp.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="smrt-planner-styles">${css}</style></head><body><main id="planner"></main><script id="smrt-planner-entry">${code.replaceAll('</script', '<\\/script')}</script></body></html>`,
);
console.log('Wrote self-contained Planner resource: app/mcp.html');
