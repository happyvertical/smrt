// The process-wide pieces the routes share: a short-lived cache of what the
// local CLIs report (a status check starts a process, so the dock's status
// call must not start one every time), the one sign-in manager, and the
// owner's assistant settings over the shell's preference store.
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import { getShellDb } from '../host.ts';
import { type Principal, runAs } from '../owner.ts';
import { type AgentCliStatus, detectAgentCli } from './detect.ts';
import { defaultLocateDeps, type LocateDeps } from './locate.ts';
import { AgentLogin } from './login.ts';
import {
  ASSISTANT_CUSTOMIZE_PERMISSION,
  ASSISTANT_PERSONALIZE_PERMISSION,
  type AssistantPreferenceStore,
  createAssistantSettings,
} from './settings.ts';
import { AGENT_TOOLS, type AgentTool } from './tools.ts';

const CACHE_MS = 15_000;

let depsOverride: LocateDeps | null = null;
const cache = new Map<AgentTool, { at: number; status: AgentCliStatus }>();
let loginManager: AgentLogin | null = null;

function deps(): LocateDeps {
  return depsOverride ?? defaultLocateDeps();
}

/** Tests: where to look for the CLIs. Pass null to restore the machine's. */
export function configureAgentCli(next: LocateDeps | null): void {
  depsOverride = next;
  cache.clear();
  loginManager = null;
}

export function invalidateCliStatus(tool?: AgentTool): void {
  if (tool) cache.delete(tool);
  else cache.clear();
}

export function agentLogin(): AgentLogin {
  loginManager ??= new AgentLogin({
    deps: deps(),
    onEnd: (tool) => invalidateCliStatus(tool),
  });
  return loginManager;
}

/** One tool's status; `fresh` skips the cache. */
export async function cliStatus(
  tool: AgentTool,
  options: { fresh?: boolean } = {},
): Promise<AgentCliStatus> {
  const hit = cache.get(tool);
  if (!options.fresh && hit && Date.now() - hit.at < CACHE_MS)
    return hit.status;
  const status = await detectAgentCli(tool, deps());
  cache.set(tool, { at: Date.now(), status });
  return status;
}

export function allCliStatus(
  options: { fresh?: boolean } = {},
): Promise<AgentCliStatus[]> {
  return Promise.all(AGENT_TOOLS.map((tool) => cliStatus(tool, options)));
}

export const agentCliDeps = deps;

/** The owner's engine and onboarding settings (preferences kind `assistant`). */
export function assistantSettings() {
  return createAssistantSettings(
    async () =>
      createPreferenceStore({
        db: await getShellDb(),
      }) as unknown as AssistantPreferenceStore,
  );
}

/**
 * Run `fn` as the verified owner with the two assistant-setting rights. The
 * caller has already checked the owner against shell.db (`ownerOf`); these
 * rights only open the non-secret `assistant` preference, so an install whose
 * owner role predates them still works (the role is reseeded on a later start).
 */
export function asSettingsOwner<T>(
  owner: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  return runAs(
    {
      ...owner,
      scopes: [
        ...(owner.scopes ?? []),
        ASSISTANT_CUSTOMIZE_PERMISSION,
        ASSISTANT_PERSONALIZE_PERMISSION,
      ],
    },
    fn,
  );
}
