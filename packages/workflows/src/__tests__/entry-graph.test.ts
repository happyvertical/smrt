import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('imports the built package in plain Node without reaching Svelte or UI modules', async () => {
  // A fresh process sees the actual ESM graph, including imports otherwise
  // hidden by Vitest's module cache. Node resolves all conditional exports.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        modules.add(result.url);
        return result;
      } });
      const api = await import('@happyvertical/smrt-workflows');
      for (const name of ['createWorkflowRunJobs', 'registerWorkflowRunHandler', 'WORKFLOW_RUN_HANDLER'])
        if (!(name in api)) throw new Error('missing export ' + name);
      process.stdout.write(JSON.stringify([...modules]));
    `,
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      timeout: 15000,
      maxBuffer: 2_000_000,
    },
  );
  const modules = JSON.parse(stdout) as string[];
  expect(modules.length).toBeGreaterThan(20);
  expect(
    modules.filter((url) =>
      /(?:\.svelte(?:$|\/)|(?:^|\/)svelte(?:\/|$)|@sveltejs|smrt-(?:svelte|ui|app-shell|chat)(?:\/|$)|\/dist\/ui\.js$)/.test(
        url,
      ),
    ),
  ).toEqual([]);
});
