/**
 * Agent-docs refresh after a scaffold (#4878 item D).
 *
 * `smrt cookbook apply` and `smrt init` call {@link refreshScaffoldedProject}
 * once the project is written, so a new app starts with the AGENTS.md block,
 * the framework reference and the knowledge bundle. It never throws, never
 * changes an exit status and never writes to stdout (cookbook `--json` owns
 * it): every message goes to stderr. With no smrt package installed yet (no
 * install ran) it prints one hint instead of failing.
 */

import { safeRefreshAgentDocs } from './docs-refresh.js';

/** Test seam: replace `refresh` to observe or fail the call. */
export const scaffoldAgentDocs = {
  refresh: safeRefreshAgentDocs,
};

export async function refreshScaffoldedProject(dir: string): Promise<void> {
  const err = (text: string): void => {
    try {
      console.error(text);
    } catch {
      // A broken sink must not fail the scaffold.
    }
  };
  try {
    const result = await scaffoldAgentDocs.refresh({
      cwd: dir,
      mode: 'write',
      verbose: false,
      log: { out: err, err },
    });
    if (result.status === 'skipped-nothing-installed') {
      err('Agent docs: install dependencies, then run `smrt docs:agents`.');
    }
  } catch (error) {
    err(
      `agent docs refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
