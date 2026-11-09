/**
 * Installed size and cold start of a finished bundle (design section 5).
 *
 * "Cold start" is the wall time from `spawn()` of the bundled Node sidecar to
 * the first 2xx answer of its health route on a free loopback port. It is a
 * NEW PROCESS, not a cold OS file cache (dropping caches needs root). Two
 * series are measured: `firstRun` (a new data directory every run, a fresh
 * copy of the prepared template when one is given) and `warm` (one data
 * directory reused after an untimed priming run, a normal relaunch). Schema
 * creation is NOT included: SMRT apps never create tables at run time.
 *
 * Everything that touches the machine is a seam (`MeasureSeams`: spawn, the
 * HTTP probe, a free port, the clock, sleeping, data directories), so the
 * timing logic is tested without a process. The probe never follows a
 * redirect and gives each request 500 ms; one start gets 60 s overall. The
 * child environment is built by the caller from the sidecar manifest with the
 * same `buildSidecarEnv` the Rust shell mirrors.
 */

import {
  buildSidecarEnv,
  type SidecarManifestV1,
} from '../sidecar-manifest.js';
import { BundleError } from './errors.js';
import type { BundleMeasurements, SeriesStats } from './report.js';

export interface MeasureChild {
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Resolves when the process has exited (never rejects). */
  readonly exit: Promise<unknown>;
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
  /** A fresh private directory, pre-filled from `template` when given. */
  makeDataDir(template?: string): Promise<DataDirectory>;
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
  /**
   * Prepared data directory copied for every run. SMRT apps do not create
   * their schema at run time, so this is how a measurable start gets one.
   */
  readonly dataTemplate?: string;
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

async function stop(
  child: MeasureChild,
  seams: MeasureSeams,
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
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const deadline = seams.now() + graceMs;
  while (!exited && seams.now() < deadline) await seams.sleep(25);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await child.exit.catch(() => undefined);
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
    cwd: request.resourcesDir,
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
    await stop(child, seams, request.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
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
    cwd: request.resourcesDir,
    env: request.baseEnv,
  });

  const firstRun: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const dir = await seams.makeDataDir(request.dataTemplate);
    try {
      firstRun.push(await timeOneStart(request, seams, dir.path));
    } finally {
      await dir.dispose().catch(() => undefined);
    }
  }

  const warm: number[] = [];
  const shared = await seams.makeDataDir(request.dataTemplate);
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
