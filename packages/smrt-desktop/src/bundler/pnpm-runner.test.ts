import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BundleError } from './errors.js';
import { buildPnpmInstallArgs } from './install-args.js';
import {
  createPnpmRunner,
  pnpmCommand,
  type RunnerChild,
  type SpawnLike,
} from './pnpm-runner.js';

const args = buildPnpmInstallArgs({
  target: { pnpm: { os: 'linux', cpu: 'x64', libc: 'glibc' } },
});

describe('pnpmCommand', () => {
  it('runs pnpm directly with the exact tokens on POSIX', () => {
    expect(pnpmCommand(args, 'linux')).toEqual({ command: 'pnpm', args });
  });

  it('runs the fixed command through cmd.exe on Windows', () => {
    const windows = pnpmCommand(args, 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(windows.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(windows.args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'pnpm']);
    expect(windows.args.slice(4)).toEqual(args);
    expect(pnpmCommand(['--version'], 'win32').command).toBe('cmd.exe');
  });

  it.each([
    'a b',
    '$(id)',
    'x;y',
    '`z`',
    'a&b',
    'a|b',
    '"q"',
    'a>b',
    '%PATH%',
    '',
  ])('refuses the shell-significant token %j', (token) => {
    expect(() => pnpmCommand(['install', token], 'win32')).toThrow(BundleError);
    expect(() => pnpmCommand(['install', token], 'linux')).toThrow(BundleError);
  });
});

interface FakeChild extends RunnerChild {
  emit(event: string, ...values: unknown[]): boolean;
}

function fakeSpawn(
  script: (child: FakeChild) => void,
  record: { calls: unknown[][] } = { calls: [] },
): SpawnLike {
  return (command, argv, options) => {
    record.calls.push([command, argv, options]);
    const emitter = new EventEmitter() as FakeChild & EventEmitter;
    (emitter as unknown as { stdout: PassThrough }).stdout = new PassThrough();
    (emitter as unknown as { stderr: PassThrough }).stderr = new PassThrough();
    (emitter as unknown as { kill: () => boolean }).kill = () => true;
    queueMicrotask(() => script(emitter));
    return emitter;
  };
}

describe('createPnpmRunner', () => {
  it('spawns without a shell, with the given cwd and env, and returns the exit code', async () => {
    const record = { calls: [] as unknown[][] };
    const runner = createPnpmRunner({
      platform: 'linux',
      spawn: fakeSpawn((child) => {
        (child.stderr as PassThrough).write('ERR_PNPM_OUTDATED_LOCKFILE boom');
        child.emit('close', 1, null);
      }, record),
    });
    const result = await runner.run({
      cwd: '/stage/install',
      args,
      env: { PATH: '/usr/bin' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    const [command, argv, options] = record.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('pnpm');
    expect(argv).toEqual(args);
    expect(options).toMatchObject({
      cwd: '/stage/install',
      env: { PATH: '/usr/bin' },
      shell: false,
    });
  });

  it('reports a spawn error as a failed run', async () => {
    const runner = createPnpmRunner({
      platform: 'linux',
      spawn: fakeSpawn((child) => child.emit('error', new Error('ENOENT'))),
    });
    expect(
      (await runner.run({ cwd: '/x', args: ['--version'], env: {} })).exitCode,
    ).toBe(-1);
  });

  it('reports a synchronous spawn failure as a failed run', async () => {
    const runner = createPnpmRunner({
      platform: 'linux',
      spawn: () => {
        throw new Error('boom');
      },
    });
    expect(
      (await runner.run({ cwd: '/x', args: ['--version'], env: {} })).exitCode,
    ).toBe(-1);
  });

  it('keeps only a bounded tail of the output', async () => {
    const runner = createPnpmRunner({
      platform: 'linux',
      tailBytes: 64,
      spawn: fakeSpawn((child) => {
        (child.stdout as PassThrough).write('x'.repeat(10_000));
        (child.stdout as PassThrough).write('END');
        child.emit('close', 0, null);
      }),
    });
    const result = await runner.run({
      cwd: '/x',
      args: ['--version'],
      env: {},
    });
    expect(result.output.length).toBeLessThanOrEqual(64);
    expect(result.output.endsWith('END')).toBe(true);
  });

  it('kills pnpm after the timeout', async () => {
    let killed = false;
    const runner = createPnpmRunner({
      platform: 'linux',
      timeoutMs: 10,
      spawn: (command, argv, options) => {
        const child = fakeSpawn(() => undefined)(command, argv, options);
        (child as unknown as { kill: () => boolean }).kill = () => {
          killed = true;
          return true;
        };
        return child;
      },
    });
    const result = await runner.run({
      cwd: '/x',
      args: ['--version'],
      env: {},
    });
    expect(result).toMatchObject({ exitCode: -1 });
    expect(killed).toBe(true);
  });

  it('reads the pnpm version, or unknown', async () => {
    const ok = createPnpmRunner({
      platform: 'linux',
      spawn: fakeSpawn((child) => {
        (child.stdout as PassThrough).write('11.25.0\n');
        child.emit('close', 0, null);
      }),
    });
    expect(await ok.version({}, '/x')).toBe('11.25.0');
    const bad = createPnpmRunner({
      platform: 'linux',
      spawn: fakeSpawn((child) => {
        (child.stdout as PassThrough).write('not a version\n');
        child.emit('close', 0, null);
      }),
    });
    expect(await bad.version({}, '/x')).toBe('unknown');
  });
});
