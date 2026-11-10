// Is the tool installed, which version, and is the person signed in. Only the
// tool's own commands answer (`--version`, `claude auth status`, `codex login
// status`): no credential file or keychain item is read. The output of a
// status command can hold an email or an organisation name; it is parsed in
// memory for the one yes/no that is needed and dropped.
import { dirname } from 'node:path';
import { childEnv, nodeDir } from './env.ts';
import { defaultLocateDeps, type LocateDeps, locateBinary } from './locate.ts';
import { runCollect } from './runner.ts';
import { AGENT_TOOL_INFO, AGENT_TOOLS, type AgentTool } from './tools.ts';

/** What the browser may know about a tool. No path, no account detail. */
export interface AgentCliStatus {
  tool: AgentTool;
  label: string;
  installed: boolean;
  version?: string;
  /** `null` when it could not be asked (the tool did not start). */
  signedIn: boolean | null;
  installUrl: string;
}

export interface AgentCliLocation {
  path: string;
  /** Directories the child needs on PATH (the binary's own, and node's). */
  extraPath: string[];
}

const VERSION_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 20_000;

export function cliEnv(
  location: AgentCliLocation,
  base: Readonly<Record<string, string | undefined>> = process.env,
  extra?: Record<string, string>,
): Record<string, string> {
  return childEnv(base, {
    extraPath: location.extraPath,
    ...(extra ? { extra } : {}),
  });
}

/** The binary's location plus the PATH additions its child needs. */
export async function locateCli(
  tool: AgentTool,
  deps: LocateDeps = defaultLocateDeps(),
): Promise<AgentCliLocation | null> {
  const path = await locateBinary(tool, deps);
  return path ? { path, extraPath: [dirname(path), nodeDir()] } : null;
}

function versionOf(text: string): string | undefined {
  return /\d+\.\d+\.\d+[\w.+-]*/.exec(text)?.[0];
}

function signedInFrom(
  tool: AgentTool,
  exitCode: number | null,
  stdout: string,
) {
  if (tool === 'claude-code') {
    try {
      const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
    } catch {
      // fall through to the exit code
    }
  }
  return exitCode === 0;
}

export async function detectAgentCli(
  tool: AgentTool,
  deps: LocateDeps = defaultLocateDeps(),
): Promise<AgentCliStatus> {
  const info = AGENT_TOOL_INFO[tool];
  const base = {
    tool,
    label: info.label,
    installUrl: info.installUrl,
  };
  const location = await locateCli(tool, deps);
  if (!location) return { ...base, installed: false, signedIn: false };
  const env = cliEnv(location, deps.env);
  const version = await runCollect({
    command: location.path,
    args: info.versionArgs,
    env,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (version.spawnError || version.exitCode !== 0)
    return { ...base, installed: true, signedIn: null };
  const status = await runCollect({
    command: location.path,
    args: info.statusArgs,
    env,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  const found = versionOf(version.stdout);
  return {
    ...base,
    installed: true,
    ...(found ? { version: found } : {}),
    signedIn:
      status.spawnError || status.timedOut
        ? null
        : signedInFrom(tool, status.exitCode, status.stdout),
  };
}

export async function detectAgentClis(
  deps: LocateDeps = defaultLocateDeps(),
): Promise<AgentCliStatus[]> {
  return Promise.all(AGENT_TOOLS.map((tool) => detectAgentCli(tool, deps)));
}
