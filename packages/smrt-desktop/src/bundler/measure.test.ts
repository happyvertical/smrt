import { describe, expect, it } from 'vitest';
import { BundleError } from './errors.js';
import {
  type MeasureChild,
  type MeasureRequest,
  type MeasureSeams,
  measureBundle,
  median,
  stopMeasuredProcess,
  summarizeSeries,
} from './measure.js';

const sidecar = {
  version: 1 as const,
  executable: 'smrt-start-node',
  args: ['app/build/index.js'],
  healthRoute: '/api/_runtime/health',
  dataDirectory: 'runtime',
  env: { NODE_ENV: 'production', NODE_OPTIONS: '' },
};

const request: MeasureRequest = {
  executablePath: '/bundle/binaries/smrt-start-node-x',
  resourcesDir: '/bundle/resources',
  bundleRoot: '/bundle',
  sidecar,
  baseEnv: { PATH: '/usr/bin', NODE_OPTIONS: '--require evil' },
  files: { count: 7, bytes: 1234 },
  runs: 3,
};

interface Harness {
  seams: MeasureSeams;
  spawns: Parameters<MeasureSeams['spawn']>[0][];
  kills: string[];
  dataDirs: string[];
  disposed: string[];
  urls: string[];
  templates: (string | undefined)[];
}

/**
 * A scripted machine: every start becomes healthy after `bootMs` of fake
 * time; the clock advances only through `sleep` and `health`.
 */
function harness(options: {
  bootMs: number | number[];
  exitEarly?: boolean;
  neverHealthy?: boolean;
  statuses?: number[];
}): Harness {
  let clock = 1000;
  let port = 40000;
  let start = 0;
  let startIndex = -1;
  const spawns: Harness['spawns'] = [];
  const kills: string[] = [];
  const dataDirs: string[] = [];
  const disposed: string[] = [];
  const urls: string[] = [];
  const templates: (string | undefined)[] = [];
  const statusQueue = [...(options.statuses ?? [])];
  const seams: MeasureSeams = {
    spawn(req) {
      spawns.push(req);
      start = clock;
      startIndex += 1;
      let resolveExit: (value: unknown) => void = () => undefined;
      const exit = new Promise<unknown>((resolve) => {
        resolveExit = resolve;
      });
      if (options.exitEarly) resolveExit({ code: 1 });
      const child: MeasureChild = {
        kill(signal) {
          kills.push(signal);
          resolveExit({ signal });
        },
        exit,
      };
      return child;
    },
    async version() {
      return 'v26.8.1\n';
    },
    async health(url) {
      urls.push(url);
      clock += 1;
      const boot = Array.isArray(options.bootMs)
        ? (options.bootMs[startIndex % options.bootMs.length] as number)
        : options.bootMs;
      if (options.neverHealthy) return undefined;
      if (clock - start < boot) return undefined;
      return statusQueue.shift() ?? 200;
    },
    async freePort() {
      port += 1;
      return port;
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    async makeDataDir(template) {
      const path = `/tmp/data-${dataDirs.length}`;
      dataDirs.push(path);
      templates.push(template);
      return {
        path,
        dispose: async () => {
          disposed.push(path);
        },
      };
    },
    diskUsage: async () => 4096,
  };
  return { seams, spawns, kills, dataDirs, disposed, urls, templates };
}

describe('statistics', () => {
  it('takes the median of odd and even lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(BundleError);
  });

  it('summarises samples with median and max', () => {
    expect(summarizeSeries([10.04, 30, 20])).toEqual({
      runs: 3,
      samplesMs: [10, 30, 20],
      medianMs: 20,
      maxMs: 30,
    });
  });
});

describe('measureBundle', () => {
  it('times spawn to the first 2xx for both series', async () => {
    const h = harness({ bootMs: 100 });
    const result = await measureBundle(request, h.seams);
    expect(result.nodeVersionOutput).toBe('v26.8.1');
    expect(result.healthRoute).toBe('/api/_runtime/health');
    expect(result.coldStart.firstRun.runs).toBe(3);
    expect(result.coldStart.warm.runs).toBe(3);
    for (const stats of [result.coldStart.firstRun, result.coldStart.warm]) {
      expect(stats.medianMs).toBeGreaterThanOrEqual(100);
      expect(stats.medianMs).toBeLessThan(140);
      expect(stats.maxMs).toBeGreaterThanOrEqual(stats.medianMs);
    }
    expect(result.installed).toEqual({
      apparentBytes: 1234,
      onDiskBytes: 4096,
      files: 7,
    });
  });

  it('reports the median of differing runs', async () => {
    const h = harness({ bootMs: [50, 200, 100] });
    const result = await measureBundle(request, h.seams);
    const samples = result.coldStart.firstRun.samplesMs;
    expect(samples).toHaveLength(3);
    const sorted = [...samples].sort((a, b) => a - b);
    expect(result.coldStart.firstRun.medianMs).toBe(sorted[1]);
    expect(result.coldStart.firstRun.maxMs).toBe(sorted[2]);
  });

  it('uses a new data directory per first run and one reused directory when warm', async () => {
    const h = harness({ bootMs: 10 });
    await measureBundle(request, h.seams);
    // 3 first-run directories + 1 shared directory.
    expect(h.dataDirs).toHaveLength(4);
    expect(h.disposed).toEqual(
      h.dataDirs.map((_, i) => `/tmp/data-${i}`).sort(),
    );
    const dataDirsPassed = h.spawns.map((s) => s.env.SMRT_DATA_DIR);
    // first-run starts: all different; priming + warm starts: all the same.
    expect(new Set(dataDirsPassed.slice(0, 3)).size).toBe(3);
    expect(new Set(dataDirsPassed.slice(3)).size).toBe(1);
    expect(h.spawns).toHaveLength(3 + 1 + 3);
  });

  it('copies the prepared data template for every directory', async () => {
    const h = harness({ bootMs: 5 });
    await measureBundle({ ...request, dataTemplate: '/prepared' }, h.seams);
    expect(h.templates).toEqual(Array(4).fill('/prepared'));
    const bare = harness({ bootMs: 5 });
    await measureBundle(request, bare.seams);
    expect(bare.templates).toEqual(Array(4).fill(undefined));
  });

  it('starts the sidecar the way the shell does', async () => {
    const h = harness({ bootMs: 10 });
    await measureBundle({ ...request, runs: 1 }, h.seams);
    const first = h.spawns[0];
    expect(first?.command).toBe(request.executablePath);
    expect(first?.args).toEqual(['app/build/index.js']);
    expect(first?.cwd).toBe('/bundle/resources');
    expect(first?.env.HOST).toBe('127.0.0.1');
    expect(first?.env.PORT).toBe('40001');
    expect(first?.env.ORIGIN).toBe('http://127.0.0.1:40001');
    expect(first?.env.NODE_ENV).toBe('production');
    // The manifest neutralises the inherited NODE_OPTIONS.
    expect(first?.env.NODE_OPTIONS).toBe('');
    expect(h.urls[0]).toBe('http://127.0.0.1:40001/api/_runtime/health');
  });

  it('keeps polling through a non-2xx answer', async () => {
    const h = harness({ bootMs: 0, statuses: [503, 302, 200] });
    const result = await measureBundle({ ...request, runs: 1 }, h.seams);
    expect(result.coldStart.firstRun.samplesMs[0]).toBeGreaterThan(20);
  });

  it('stops every child it started', async () => {
    const h = harness({ bootMs: 5 });
    await measureBundle(request, h.seams);
    expect(h.kills.filter((k) => k === 'SIGTERM')).toHaveLength(7);
  });

  it('fails when the sidecar exits before answering', async () => {
    const h = harness({ bootMs: 5, exitEarly: true });
    await expect(measureBundle(request, h.seams)).rejects.toMatchObject({
      code: 'smoke_start_failed',
      exitCode: 7,
    });
  });

  it('fails after the overall timeout and still stops the child', async () => {
    const h = harness({ bootMs: 0, neverHealthy: true });
    await expect(
      measureBundle({ ...request, timeoutMs: 1000 }, h.seams),
    ).rejects.toMatchObject({ code: 'smoke_start_failed' });
    expect(h.kills).toContain('SIGTERM');
  });

  it('rejects an out-of-range run count', async () => {
    const h = harness({ bootMs: 5 });
    await expect(
      measureBundle({ ...request, runs: 0 }, h.seams),
    ).rejects.toBeInstanceOf(BundleError);
  });
});

describe('stopMeasuredProcess', () => {
  /** A group whose leader exits at once but whose grandchildren live on. */
  function group(options: {
    leaderExitsOn: 'SIGTERM' | 'SIGKILL';
    grandchildDiesOn: 'SIGTERM' | 'SIGKILL' | 'never';
  }) {
    const kills: string[] = [];
    let resolveExit: (value: unknown) => void = () => undefined;
    const exit = new Promise<unknown>((resolve) => {
      resolveExit = resolve;
    });
    let grandchildAlive = true;
    const child: MeasureChild = {
      async kill(signal) {
        kills.push(signal);
        if (signal === options.leaderExitsOn) resolveExit({ signal });
        if (signal === options.grandchildDiesOn) grandchildAlive = false;
      },
      exit,
      alive: async () => grandchildAlive,
    };
    return { child, kills };
  }

  let clock = 0;
  const clockSeams = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };

  it('does not take the exit of the child for the end of its group', async () => {
    clock = 0;
    // The leader dies on SIGTERM; the grandchild ignores it. Before the fix
    // the child's exit ended the wait and the grandchild kept running.
    const { child, kills } = group({
      leaderExitsOn: 'SIGTERM',
      grandchildDiesOn: 'SIGKILL',
    });
    await stopMeasuredProcess(child, clockSeams, 500);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops after SIGTERM alone when the whole group went away', async () => {
    clock = 0;
    const { child, kills } = group({
      leaderExitsOn: 'SIGTERM',
      grandchildDiesOn: 'SIGTERM',
    });
    await stopMeasuredProcess(child, clockSeams, 500);
    expect(kills).toEqual(['SIGTERM']);
  });

  it('fails the bundle when a process is still running after SIGKILL', async () => {
    clock = 0;
    const { child, kills } = group({
      leaderExitsOn: 'SIGKILL',
      grandchildDiesOn: 'never',
    });
    await expect(
      stopMeasuredProcess(child, clockSeams, 500),
    ).rejects.toMatchObject({
      code: 'measured_process_survived',
      category: 'verification',
      exitCode: 5,
    });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('fails the whole measurement when a started sidecar leaves a process behind', async () => {
    const h = harness({ bootMs: 5 });
    const spawn = h.seams.spawn;
    h.seams.spawn = (req) => ({ ...spawn(req), alive: async () => true });
    await expect(
      measureBundle({ ...request, runs: 1, killGraceMs: 50 }, h.seams),
    ).rejects.toMatchObject({ code: 'measured_process_survived' });
  });

  it('treats a child without a liveness probe as stopped once it exited', async () => {
    clock = 0;
    const kills: string[] = [];
    const child: MeasureChild = {
      kill(signal) {
        kills.push(signal);
      },
      exit: Promise.resolve({ code: 0 }),
    };
    await stopMeasuredProcess(child, clockSeams, 500);
    expect(kills).toEqual(['SIGTERM']);
  });
});
