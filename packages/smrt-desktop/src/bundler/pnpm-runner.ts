/**
 * Runs `pnpm` for the bundler without a shell.
 *
 * Every argv token comes from the closed tables in `install-args.ts`; user
 * strings never reach argv (paths travel through `cwd`). The check below is a
 * second line of defence: a token outside `[A-Za-z0-9._=:/-]` is refused. On
 * Windows, Node refuses to spawn `.cmd` shims without a shell (CVE-2024-27980
 * hardening), so the fixed command is run as `cmd.exe /d /s /c pnpm <tokens>`,
 * which is safe only because of that token check.
 *
 * The child's output is collected into a bounded tail that is used to
 * classify a failure (`ERR_PNPM_OUTDATED_LOCKFILE`, integrity errors). It is
 * never printed or stored: it can contain proxy credentials or package paths.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { BundleError } from './errors.js';

export interface PnpmRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface PnpmResult {
  readonly exitCode: number;
  /** Bounded tail of stdout and stderr; for classification only. */
  readonly output: string;
}

/** The slice of a child process this runner uses. */
export interface RunnerChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => RunnerChild;

export interface PnpmRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
  /** Kill pnpm after this long. Default 30 minutes. */
  readonly timeoutMs?: number;
  /** Tail kept for classification. Default 16 KiB. */
  readonly tailBytes?: number;
}

const TOKEN = /^[A-Za-z0-9._=:/-]+$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TAIL_BYTES = 16 * 1024;

/** The command and argv to spawn for `pnpm <args>` on `platform`. */
export function pnpmCommand(
  args: readonly string[],
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>> = {},
): { command: string; args: string[] } {
  if (!args.every((token) => TOKEN.test(token))) {
    throw new BundleError('pnpm_failed');
  }
  if (platform === 'win32') {
    const shell = env.ComSpec;
    return {
      command:
        typeof shell === 'string' && shell.length > 0 ? shell : 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm', ...args],
    };
  }
  return { command: 'pnpm', args: [...args] };
}

function collect(
  stream: NodeJS.ReadableStream | null,
  tail: { text: string },
  limit: number,
): void {
  stream?.on('data', (chunk: Buffer | string) => {
    tail.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (tail.text.length > limit * 2) tail.text = tail.text.slice(-limit);
  });
}

/** Create the default pnpm runner (`child_process.spawn`, `shell: false`). */
export function createPnpmRunner(options: PnpmRunnerOptions = {}) {
  const platform = options.platform ?? process.platform;
  const spawn: SpawnLike =
    options.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o) as RunnerChild);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;

  function run(request: PnpmRequest): Promise<PnpmResult> {
    const target = pnpmCommand(request.args, platform, request.env);
    return new Promise((resolve) => {
      const tail = { text: '' };
      let settled = false;
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, output: tail.text.slice(-tailBytes) });
      };
      let child: RunnerChild;
      try {
        child = spawn(target.command, target.args, {
          cwd: request.cwd,
          env: { ...request.env },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        resolve({ exitCode: -1, output: '' });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(-1);
      }, timeoutMs);
      collect(child.stdout, tail, tailBytes);
      collect(child.stderr, tail, tailBytes);
      child.on('error', () => finish(-1));
      child.on('close', (code) => finish(code ?? -1));
    });
  }

  /** `pnpm --version`, or `unknown` when it cannot be run. */
  async function version(
    env: Readonly<Record<string, string>>,
    cwd: string,
  ): Promise<string> {
    const result = await run({ cwd, args: ['--version'], env });
    const line = result.output.trim().split(/\r?\n/).pop() ?? '';
    return result.exitCode === 0 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(line)
      ? line
      : 'unknown';
  }

  return { run, version };
}
