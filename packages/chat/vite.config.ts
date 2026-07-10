import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import {
  viteWorkspaceAliases,
  workspaceAliasPackageNames,
} from './workspace-aliases.js';

export default defineConfig(async ({ command, mode }) => {
  const isPackageBuild =
    mode === 'library' || process.env.SMRT_PACKAGE_BUILD === '1';

  if (isPackageBuild) {
    const { createPackageConfig } = await import('../../vite.config.base.js');
    const config = createPackageConfig('chat', {
      entries: [
        'ui',
        'playground',
        // Internal agent-runtime surface (S5 #1392): emitted under a dedicated
        // subpath, NOT folded into the package index, so only trusted in-process
        // agent runtimes opt into `sendAgentReply`.
        {
          name: 'internal/agent-runtime',
          source: 'src/internal/agent-runtime.ts',
        },
      ],
      svelte: 'svelte',
      dtsExclude: ['src/routes/**/*', 'src/app.html'],
    });

    return typeof config === 'function'
      ? await config({ command, mode })
      : config;
  }

  return {
    resolve: {
      alias: viteWorkspaceAliases,
    },
    optimizeDeps: {
      exclude: workspaceAliasPackageNames,
    },
    ssr: {
      noExternal: workspaceAliasPackageNames,
    },
    plugins: [sveltekit()],
  };
});
