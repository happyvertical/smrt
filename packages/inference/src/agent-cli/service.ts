import { type AgentCliStatus, detectAgentCli } from './detect.js';
import { defaultLocateDeps, type LocateDeps } from './locate.js';
import { AgentLogin } from './login.js';
import { AGENT_TOOLS, type AgentTool } from './tools.js';

/** A host-local cache and sign-in manager. Never reads CLI credential stores. */
export function createAgentCliService(initialDeps: LocateDeps | null = null) {
  const CACHE_MS = 15_000;

  let depsOverride: LocateDeps | null = initialDeps;
  const cache = new Map<string, { at: number; status: AgentCliStatus }>();
  let loginManager: AgentLogin | null = null;

  function deps(): LocateDeps {
    return depsOverride ?? defaultLocateDeps();
  }

  /** Tests: where to look for the CLIs. Pass null to restore the machine's. */
  function configureAgentCli(next: LocateDeps | null): void {
    depsOverride = next;
    cache.clear();
    loginManager = null;
  }

  function invalidateCliStatus(tool?: AgentTool): void {
    if (tool)
      for (const key of cache.keys()) {
        if (key.startsWith(`${tool}:`)) cache.delete(key);
      }
    else cache.clear();
  }

  function agentLogin(): AgentLogin {
    loginManager ??= new AgentLogin({
      deps: deps(),
      onEnd: (tool) => invalidateCliStatus(tool),
    });
    return loginManager;
  }

  /** One tool's status; `fresh` skips the cache. */
  async function cliStatus(
    tool: AgentTool,
    options: { fresh?: boolean; protection?: boolean } = {},
  ): Promise<AgentCliStatus> {
    const key = `${tool}:${options.protection !== false}`;
    const hit = cache.get(key);
    if (!options.fresh && hit && Date.now() - hit.at < CACHE_MS)
      return hit.status;
    const status = await detectAgentCli(
      tool,
      deps(),
      options.protection !== false,
    );
    cache.set(key, { at: Date.now(), status });
    return status;
  }

  function allCliStatus(
    options: { fresh?: boolean; protection?: boolean } = {},
  ): Promise<AgentCliStatus[]> {
    return Promise.all(AGENT_TOOLS.map((tool) => cliStatus(tool, options)));
  }

  return {
    configureAgentCli,
    invalidateCliStatus,
    agentLogin,
    cliStatus,
    allCliStatus,
    agentCliDeps: deps,
  };
}
