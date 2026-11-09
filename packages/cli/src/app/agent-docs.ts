/**
 * Agent-docs freshness in the `smrt app` lifecycle (#4878 item C).
 *
 * - `install` refreshes the docs (it is the documented setup entry point).
 * - `dev` refreshes only a missing or stale bundle; skipped under `CI` and
 *   `SMRT_AGENT_DOCS=off`.
 * - `build` never writes: one stderr warning when the bundle is missing or
 *   stale; skipped under `SMRT_AGENT_DOCS=off`.
 *
 * Agent docs must never fail an operation. Every function here catches
 * everything, reports on stderr as plain text (not the JSON error envelope) and
 * returns normally; none touches stdout or an exit status.
 */

import type {
  AgentDocsInspection,
  RefreshAgentDocsOptions,
  RefreshAgentDocsResult,
} from '../commands/docs-refresh.js';
import type { AppCommandIo } from './runtime.js';

/** Replaceable collaborators (tests, embedding). */
export interface AgentDocsHooks {
  refresh?(options: RefreshAgentDocsOptions): Promise<RefreshAgentDocsResult>;
  inspect?(cwd: string): AgentDocsInspection;
  /** Environment to read `CI` / `SMRT_AGENT_DOCS` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** `CI` counts as set for any non-empty value except `0` and `false`. */
export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return (
    value !== undefined && value !== '' && value !== '0' && value !== 'false'
  );
}

/** `SMRT_AGENT_DOCS=off` (case-insensitive) disables dev refresh and the build warning. */
export function isAgentDocsOff(env: NodeJS.ProcessEnv): boolean {
  return env.SMRT_AGENT_DOCS?.trim().toLowerCase() === 'off';
}

function line(io: AppCommandIo, text: string): void {
  try {
    io.stderr(`${text}\n`);
  } catch {
    // Reporting is best effort.
  }
}

async function refresh(
  mode: 'write' | 'if-stale',
  sourceRoot: string,
  io: AppCommandIo,
  hooks: AgentDocsHooks | undefined,
): Promise<void> {
  try {
    const run =
      hooks?.refresh ??
      (await import('../commands/docs-refresh.js')).safeRefreshAgentDocs;
    // The hook is a seam and may throw; the default never does.
    const result = await run({
      cwd: sourceRoot,
      mode,
      verbose: false,
      log: {
        out: () => {},
        err: (text) => line(io, `smrt: ${text.trim()}`),
      },
    });
    if (result.status === 'written') {
      line(io, 'smrt: agent docs refreshed (smrt docs:agents)');
    }
  } catch (error) {
    line(
      io,
      `smrt: agent docs refresh failed (${error instanceof Error ? error.message : String(error)}); continuing`,
    );
  }
}

/** `smrt app install`: always refresh. */
export function refreshAgentDocsOnInstall(
  sourceRoot: string,
  io: AppCommandIo,
  hooks?: AgentDocsHooks,
): Promise<void> {
  return refresh('write', sourceRoot, io, hooks);
}

/** `smrt app dev`: refresh a missing or stale bundle unless CI / opted out. */
export async function refreshAgentDocsOnDev(
  sourceRoot: string,
  io: AppCommandIo,
  hooks?: AgentDocsHooks,
): Promise<void> {
  const env = hooks?.env ?? process.env;
  if (isCiEnvironment(env) || isAgentDocsOff(env)) return;
  await refresh('if-stale', sourceRoot, io, hooks);
}

/** `smrt app build`: read-only; one warning line when the bundle is missing or stale. */
export async function warnAgentDocsOnBuild(
  sourceRoot: string,
  io: AppCommandIo,
  hooks?: AgentDocsHooks,
): Promise<void> {
  try {
    if (isAgentDocsOff(hooks?.env ?? process.env)) return;
    const inspect =
      hooks?.inspect ??
      (await import('../commands/docs-refresh.js')).inspectAgentDocs;
    const state = inspect(sourceRoot);
    if (!state.installed || state.bundle === 'fresh') return;
    line(
      io,
      `smrt: agent knowledge bundle is ${state.bundle}; run \`smrt docs:agents\` to refresh (SMRT_AGENT_DOCS=off silences this)`,
    );
  } catch {
    // Never fail a build over agent docs.
  }
}
