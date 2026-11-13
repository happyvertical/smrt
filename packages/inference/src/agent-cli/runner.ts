// Run a local agent CLI as a child process: prompt on stdin (never argv, so it
// is not in the process list), stdout split into lines, a hard timeout, an
// abort signal, and a clean kill of the whole process tree (the CLIs start
// helpers of their own). stderr is kept as a short tail for the class of
// failure only; it is never forwarded or logged, because a tool can echo
// request details there.
import { type ChildProcess, spawn } from 'node:child_process';

const KILL_GRACE_MS = 3_000;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** The child is killed after this long. */
  timeoutMs: number;
  onStdoutLine?(line: string): void;
}

export interface RunResult {
  exitCode: number | null;
  termination: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all (`ENOENT`, ...). */
  spawnError?: string;
  stderrTail: string;
}

const live = new Set<ChildProcess>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  // A child must not outlive the server that started it.
  process.once('exit', () => {
    for (const child of live) killNow(child, 'SIGKILL');
  });
}

function killNow(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {});
    } else {
      // The child leads its own process group (`detached`): the group gets
      // the signal, so its helpers go with it.
      process.kill(-pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Ask the tree to stop, then force it. */
export function killTree(child: ChildProcess): void {
  killNow(child, 'SIGTERM');
  const timer = setTimeout(() => killNow(child, 'SIGKILL'), KILL_GRACE_MS);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

export function runProcess(options: RunOptions): Promise<RunResult> {
  hookExit();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        termination: null,
        timedOut: false,
        aborted: false,
        spawnError: error instanceof Error ? error.name : 'spawn_failed',
        stderrTail: '',
      });
      return;
    }
    live.add(child);
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let stderrTail = '';
    let buffer = '';
    let settled = false;

    const stop = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const flushLine = (line: string) => {
      if (!line) return;
      try {
        options.onStdoutLine?.(line);
      } catch {
        // a consumer bug must not wedge the process
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        flushLine(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE_CHARS) buffer = '';
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on('error', () => {});
    try {
      if (options.stdin !== undefined) child.stdin?.write(options.stdin);
      child.stdin?.end();
    } catch {
      // the child died before reading; 'close' reports it
    }

    const finish = (
      exitCode: number | null,
      termination: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (buffer) flushLine(buffer);
      // Reap anything the tool left running in its group.
      if (process.platform !== 'win32') killNow(child, 'SIGKILL');
      live.delete(child);
      resolve({
        exitCode,
        termination,
        timedOut,
        aborted,
        ...(spawnError ? { spawnError } : {}),
        stderrTail,
      });
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code ?? error.name;
      finish(null, null);
    });
    child.once('close', (code, sig) => finish(code, sig));
  });
}

export interface CollectResult extends RunResult {
  stdout: string;
}

/** Run a short command and collect its stdout (bounded). */
export async function runCollect(
  options: Omit<RunOptions, 'onStdoutLine'>,
  maxChars = 64_000,
): Promise<CollectResult> {
  const lines: string[] = [];
  let size = 0;
  const result = await runProcess({
    ...options,
    onStdoutLine: (line) => {
      if (size < maxChars) {
        lines.push(line);
        size += line.length + 1;
      }
    },
  });
  return { ...result, stdout: lines.join('\n') };
}
