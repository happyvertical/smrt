// Is the tool installed, which version, and is the person signed in. Only the
// tool's own commands answer (`--version`, `claude auth status`, `codex login
// status`): no credential file or keychain item is read. The output of a
// status command can hold an email or an organisation name; it is parsed in
// memory for the one yes/no that is needed and dropped.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childEnv, nodeDir } from './env.js';
import { defaultLocateDeps, type LocateDeps, locateBinary } from './locate.js';
import { runCollect } from './runner.js';
import { buildAgentRun, TOKEN_ENV } from './session.js';
import { AGENT_TOOL_INFO, AGENT_TOOLS, type AgentTool } from './tools.js';
import { reportAgentFailure } from './turn.js';

/** What the browser may know about a tool. No path, no account detail. */
export interface AgentCliStatus {
  tool: AgentTool;
  label: string;
  installed: boolean;
  version?: string;
  /** `null` when it could not be asked (the tool did not start). */
  signedIn: boolean | null;
  installUrl: string;
  /** No model request: the exact locked command can start in this process environment. */
  ready?: boolean;
  startError?: 'runtime_unavailable' | 'cli_invocation' | 'working_directory';
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

/** Cheap startup probe: exact locked flags and empty cwd, with --help and no model/token request. */
export async function preflightAgentCli(
  tool: AgentTool,
  location: AgentCliLocation,
  baseEnv: LocateDeps['env'],
): Promise<Pick<AgentCliStatus, 'ready' | 'startError'>> {
  const fail = (
    startError: NonNullable<AgentCliStatus['startError']>,
    cause?: unknown,
  ) => {
    reportAgentFailure(tool, 'preflight', cause, startError);
    return { ready: false, startError };
  };
  let directory: string | undefined;
  let spec: ReturnType<typeof buildAgentRun> | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), 'smrt-engine-preflight-'));
    spec = buildAgentRun({
      tool,
      location,
      stateDir: directory,
      mcpUrl: 'http://127.0.0.1:1/mcp',
      token: '',
      systemPrompt: '',
      prompt: '',
      baseEnv,
    });
    // Help needs no MCP credential, not even an empty token variable.
    delete spec.env[TOKEN_ENV];
    const result = await runCollect({
      command: spec.command,
      args: [...spec.args, '--help'],
      cwd: spec.cwd,
      env: spec.env,
      stdin: '',
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (result.spawnError) return fail('runtime_unavailable');
    if (result.exitCode !== 0 || result.timedOut) return fail('cli_invocation');
    return { ready: true };
  } catch (error) {
    return fail('working_directory', error);
  } finally {
    spec?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
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
  const signedIn =
    status.spawnError || status.timedOut
      ? null
      : signedInFrom(tool, status.exitCode, status.stdout);
  const startup =
    signedIn === true ? await preflightAgentCli(tool, location, deps.env) : {};
  return {
    ...base,
    installed: true,
    ...(found ? { version: found } : {}),
    signedIn,
    ...startup,
  };
}

export async function detectAgentClis(
  deps: LocateDeps = defaultLocateDeps(),
): Promise<AgentCliStatus[]> {
  return Promise.all(AGENT_TOOLS.map((tool) => detectAgentCli(tool, deps)));
}
