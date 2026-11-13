/**
 * Installed size and cold start of a finished bundle (design section 5).
 *
 * "Cold start" is the wall time from `spawn()` of the bundled Node sidecar to
 * the first 2xx answer of its health route on a free loopback port. It is a
 * NEW PROCESS, not a cold OS file cache (dropping caches needs root). Two
 * series are measured: `firstRun` (a new, empty data directory every run) and `warm` (one data
 * directory reused after an untimed priming run, a normal relaunch). Every
 * first run starts from an EMPTY data directory, so it includes the app
 * creating its own schema on first start (smrt#4835); the priming run of the
 * warm series does that once, untimed.
 *
 * Everything that touches the machine is a seam (`MeasureSeams`: spawn, the
 * HTTP probe, a free port, the clock, sleeping, data directories), so the
 * timing logic is tested without a process. The probe never follows a
 * redirect and gives each request 500 ms; one start gets 60 s overall. The
 * child environment is built by the caller from the sidecar manifest with the
 * same `buildSidecarEnv` the Rust wrapper mirrors.
 */

import { join } from 'node:path';
import {
  buildSidecarEnv,
  type SidecarManifestV1,
} from '../sidecar-manifest.js';
import { BundleError } from './errors.js';
import type { BundleMeasurements, SeriesStats } from './report.js';

export interface MeasureChild {
  /** Host process id, when available, for resource measurements. */
  readonly pid?: number;
  /**
   * Signal the child AND everything it started: on POSIX the child is a
   * process group leader and the whole group, plus the descendants seen in
   * the process table, is signalled.
   */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
  /** Resolves when the process has exited (never rejects). */
  readonly exit: Promise<unknown>;
  /**
   * True while any process of the child's group or tree is still running
   * (zombies do not count). Absent where the platform cannot tell (Windows,
   * until a job object is used); a missing method means "assume none".
   */
  alive?(): boolean | Promise<boolean>;
  /**
   * Remove the process-level handlers that kill the child if the CLI itself
   * dies. `stopMeasuredProcess` calls it once the child is stopped.
   */
  release?(): void;
}

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface DataDirectory {
  readonly path: string;
  dispose(): Promise<void>;
}

export interface MeasureSeams {
  spawn(request: SpawnRequest): MeasureChild;
  /** Run `<command> --version` and return its trimmed stdout. */
  version(request: SpawnRequest): Promise<string>;
  /** HTTP status of a GET without following redirects; `undefined` on failure. */
  health(url: string, timeoutMs: number): Promise<number | undefined>;
  freePort(): Promise<number>;
  /** Monotonic milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A fresh, empty, private directory. */
  makeDataDir(): Promise<DataDirectory>;
  /** Allocated bytes under a directory (`blocks * 512`); POSIX only. */
  diskUsage?(root: string): Promise<number | undefined>;
}

export interface MeasureRequest {
  /** Absolute path of the bundled Node binary. */
  readonly executablePath: string;
  /** Absolute resource directory: the sidecar's working directory. */
  readonly resourcesDir: string;
  /** Absolute root of the bundle (for the on-disk size). */
  readonly bundleRoot: string;
  readonly sidecar: SidecarManifestV1;
  /** Sanitised base environment (no `NODE_OPTIONS`, no secrets). */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly files: { readonly count: number; readonly bytes: number };
  /** Timed runs per series. Default 3. */
  readonly runs?: number;
  /** Overall time allowed for one start. Default 60 000 ms. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly requestTimeoutMs?: number;
  readonly killGraceMs?: number;
}

const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 500;
const DEFAULT_KILL_GRACE_MS = 5000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Median of a non-empty list (mean of the two middle values when even). */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new BundleError('internal');
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarizeSeries(samples: readonly number[]): SeriesStats {
  const rounded = samples.map(round1);
  return {
    runs: rounded.length,
    samplesMs: rounded,
    medianMs: round1(median(rounded)),
    maxMs: Math.max(...rounded),
  };
}

const SURVIVOR_GRACE_MS = 2000;

/**
 * Stop a measured child and everything it started, then verify that nothing
 * is left. The child's exit says nothing about processes it spawned (a
 * detached grandchild keeps running and could edit the bundle after its
 * digests were checked), so the whole group is signalled with SIGTERM, given
 * `graceMs`, and then killed with SIGKILL; a process that is still there
 * after that fails the bundle (`measured_process_survived`).
 */
export async function stopMeasuredProcess(
  child: MeasureChild,
  seams: Pick<MeasureSeams, 'now' | 'sleep'>,
  graceMs: number,
): Promise<void> {
  let exited = false;
  child.exit.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  const alive = async (): Promise<boolean> =>
    child.alive === undefined ? false : await child.alive();
  const settled = async (): Promise<boolean> => exited && !(await alive());
  const waitUntil = async (done: () => Promise<boolean>, ms: number) => {
    const deadline = seams.now() + ms;
    while (!(await done()) && seams.now() < deadline) await seams.sleep(25);
  };

  try {
    try {
      await child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    await waitUntil(settled, graceMs);
    if (!(await settled())) {
      try {
        await child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      await waitUntil(settled, SURVIVOR_GRACE_MS);
    }
    if (await alive()) throw new BundleError('measured_process_survived');
  } finally {
    child.release?.();
  }
}

/** One start: spawn to first 2xx, in milliseconds. */
async function timeOneStart(
  request: MeasureRequest,
  seams: MeasureSeams,
  dataDirectory: string,
): Promise<number> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = request.pollMs ?? DEFAULT_POLL_MS;
  const requestTimeoutMs =
    request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const port = await seams.freePort();
  const env = buildSidecarEnv(
    request.sidecar,
    { port, dataDirectory },
    request.baseEnv,
  );
  const url = `http://127.0.0.1:${port}${request.sidecar.healthRoute}`;

  const startedAt = seams.now();
  const child = seams.spawn({
    command: request.executablePath,
    args: request.sidecar.args,
    cwd:
      request.sidecar.workingDirectory === 'app'
        ? join(request.resourcesDir, 'app')
        : request.resourcesDir,
    env,
  });
  let exited = false;
  child.exit.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  try {
    for (;;) {
      if (exited) throw new BundleError('smoke_start_failed');
      const status = await seams.health(url, requestTimeoutMs);
      const elapsed = seams.now() - startedAt;
      if (status !== undefined && status >= 200 && status < 300) {
        return elapsed;
      }
      if (elapsed > timeoutMs) throw new BundleError('smoke_start_failed');
      await seams.sleep(pollMs);
    }
  } finally {
    await stopMeasuredProcess(
      child,
      seams,
      request.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );
  }
}

/**
 * Measure a finished bundle. Throws `smoke_start_failed` (exit 7) when the
 * sidecar exits early or never answers its health route.
 */
export async function measureBundle(
  request: MeasureRequest,
  seams: MeasureSeams,
): Promise<BundleMeasurements> {
  const runs = request.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    throw new BundleError('internal');
  }

  const nodeVersionOutput = await seams.version({
    command: request.executablePath,
    args: ['--version'],
    cwd:
      request.sidecar.workingDirectory === 'app'
        ? join(request.resourcesDir, 'app')
        : request.resourcesDir,
    env: request.baseEnv,
  });

  const firstRun: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const dir = await seams.makeDataDir();
    try {
      firstRun.push(await timeOneStart(request, seams, dir.path));
    } finally {
      await dir.dispose().catch(() => undefined);
    }
  }

  const warm: number[] = [];
  const shared = await seams.makeDataDir();
  try {
    await timeOneStart(request, seams, shared.path); // priming run, not timed
    for (let i = 0; i < runs; i += 1) {
      warm.push(await timeOneStart(request, seams, shared.path));
    }
  } finally {
    await shared.dispose().catch(() => undefined);
  }

  const onDisk = await seams.diskUsage?.(request.bundleRoot);
  return {
    nodeVersionOutput: nodeVersionOutput.trim().slice(0, 128) || 'unknown',
    healthRoute: request.sidecar.healthRoute,
    installed: {
      apparentBytes: request.files.bytes,
      ...(onDisk === undefined ? {} : { onDiskBytes: onDisk }),
      files: request.files.count,
    },
    coldStart: {
      firstRun: summarizeSeries(firstRun),
      warm: summarizeSeries(warm),
    },
  };
}
