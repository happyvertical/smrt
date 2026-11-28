import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';
import { mcpWidgetProblems } from '../../../scripts/planner-size-budgets.mjs';

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

// Vite reads tsconfig.json, which extends the generated
// .svelte-kit/tsconfig.json. A plain Vite build never runs SvelteKit's sync,
// so generate it here: a fresh checkout (the release gate restores only build
// outputs) has none.
const sync = spawnSync('pnpm', ['exec', 'svelte-kit', 'sync'], {
  stdio: 'inherit',
});
if (sync.status !== 0) {
  console.error('svelte-kit sync failed; the MCP widget was not built.');
  process.exit(sync.status ?? 1);
}

// The widget cannot run an on-device model: the Kitchen gives it no assistant
// and serves it with empty `connectDomains`/`resourceDomains`, so no model or
// runtime can be downloaded. Library mode inlines every asset, so the speech
// host and WebLLM would put megabytes of runtime inside mcp.html (#5707).
const mcpHosts = new Map(
  ['voice-host', 'engine-host'].map((name) => [
    resolve(`src/lib/assistant/${name}.ts`),
    resolve(`src/mcp/${name}.ts`),
  ]),
);
const replaced = new Set<string>();

const result = await build({
  configFile: false,
  plugins: [
    {
      name: 'smrt-planner-mcp-hosts',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        if (source === '@mlc-ai/web-llm') return resolve('src/mcp/web-llm.ts');
        if (!importer) return;
        const found = await this.resolve(source, importer, {
          ...options,
          skipSelf: true,
        });
        const replacement = found && mcpHosts.get(found.id);
        if (found && replacement) replaced.add(found.id);
        return replacement || undefined;
      },
    },
    svelte(),
  ],
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
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="smrt-planner-styles">${css}</style></head><body><main id="planner"></main><script id="smrt-planner-entry">${code.replaceAll('</script', '<\\/script')}</script></body></html>`;
if (replaced.size !== mcpHosts.size) {
  console.error(
    'An on-device model host was not replaced; the MCP widget was not built.',
  );
  process.exit(1);
}
const problems = mcpWidgetProblems(html);
if (problems.length > 0) {
  console.error(`The MCP widget was not built:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
await mkdir('app', { recursive: true });
await writeFile('app/mcp.html', html);
console.log(
  `Wrote self-contained Planner resource: app/mcp.html (${Buffer.byteLength(html)} bytes)`,
);
