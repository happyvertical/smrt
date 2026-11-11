// Test helpers for the agent CLI suites: fake `claude` / `codex` executables
// on a temp PATH (shell scripts that answer `--version`, the status command and
// the sign-in command like the real tools, with no network) and the stream
// stub (test-fixtures/stub-cli.mjs) installed under either name.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocateDeps } from './locate.js';
import stubCli from './test-fixtures/stub-cli.mjs?raw';
import type { AgentTool } from './tools.js';

export function tempDir(prefix = 'agent-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** `dir/<binary>` is the stream stub; returns its path. */
export function installStub(dir: string, binary: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, binary);
  writeFileSync(path, stubCli);
  chmodSync(path, 0o755);
  return path;
}

/**
 * `dir/<binary>`: a shell script that behaves like the real tool's version,
 * status and login commands. Signed in = `$HOME/signed-in` exists; its login
 * command creates it. Every call dumps its environment to `$HOME/env-dump`.
 */
export function installFakeCli(
  dir: string,
  tool: AgentTool,
  options: {
    version?: string;
    brokenVersion?: boolean;
    brokenHelp?: boolean;
  } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, tool === 'claude-code' ? 'claude' : 'codex');
  const version = options.version ?? '1.2.3';
  const status =
    tool === 'claude-code'
      ? `if [ -f "$HOME/signed-in" ]; then echo '{"loggedIn":true,"email":"person@example.test","orgName":"Private Org"}'; exit 0; else echo '{"loggedIn":false}'; exit 1; fi`
      : `if [ -f "$HOME/signed-in" ]; then echo "Logged in using ChatGPT"; exit 0; else echo "Not logged in"; exit 1; fi`;
  const statusCase =
    tool === 'claude-code' ? '"auth status"' : '"login status"';
  const loginCase = tool === 'claude-code' ? '"auth login"' : '"login "';
  const script = `#!/bin/sh
env > "$HOME/env-dump"
case "$*" in *--help*) exit ${options.brokenHelp ? 2 : 0};; esac
case "$1 $2" in
  "--version "*) ${options.brokenVersion ? 'exit 3' : `echo "${tool === 'claude-code' ? `${version} (Claude Code)` : `codex-cli ${version}`}"`};;
  ${statusCase}) ${status};;
  ${loginCase}) touch "$HOME/signed-in"; exit 0;;
  *) exit 2;;
esac
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** Lookup deps over a temp HOME and PATH, no login shell. */
export function fakeDeps(
  home: string,
  pathDirs: string[],
  extraEnv: Record<string, string> = {},
): LocateDeps {
  return {
    env: {
      HOME: home,
      // /usr/bin and /bin only for the fake scripts' own `env` and `touch`.
      PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'),
      ...extraEnv,
    },
    platform: process.platform,
    home,
    loginShell: false,
    systemDirs: [],
  };
}

export const exists = existsSync;
