import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, importWorkspaceModuleMock, spawnMock } = vi.hoisted(
  () => ({
    execFileSyncMock: vi.fn(),
    importWorkspaceModuleMock: vi.fn(),
    spawnMock: vi.fn(),
  }),
);

vi.mock('@happyvertical/smrt-core/utils/import-workspace-module', () => ({
  importWorkspaceModule: importWorkspaceModuleMock,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    spawn: spawnMock,
  };
});

async function loadCommands() {
  const mod = await import('../workbench.js');
  return mod.workbenchCommands;
}

describe('workbench commands', () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-workbench-')));
    mkdirSync(join(projectRoot, 'packages', 'smrt-workbench', 'host'), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, 'packages', 'smrt-workbench', 'host', 'package.json'),
      '{"name":"smrt-workbench-host"}\n',
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    importWorkspaceModuleMock.mockResolvedValue({
      findSmrtWorkbenchWorkspaceRoot: () => projectRoot,
      resolveWorkbenchScope: (
        cwd: string,
        options: { packageName?: string },
      ) => ({
        mode: options.packageName ? 'package' : 'workspace',
        cwd,
        projectRoot,
        workspaceRoot: projectRoot,
        packageName: options.packageName,
      }),
    });
    spawnMock.mockImplementation(
      () =>
        ({
          on: (event: string, cb: (code: number) => void) => {
            if (event === 'exit') setTimeout(() => cb(0), 0);
          },
        }) as never,
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    importWorkspaceModuleMock.mockReset();
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('starts the shared workbench host with inferred scope env', async () => {
    process.chdir(projectRoot);

    await (await loadCommands())['workbench:dev'].handler([], {
      package: '@happyvertical/smrt-content',
      host: '0.0.0.0',
      port: '5580',
      'allow-remote': true,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      [
        '--dir',
        join(projectRoot, 'packages', 'smrt-workbench', 'host'),
        'dev',
        '--host',
        '0.0.0.0',
        '--port',
        '5580',
      ],
      expect.objectContaining({
        cwd: projectRoot,
        shell: false,
        env: expect.objectContaining({
          SMRT_WORKBENCH_CWD: projectRoot,
          SMRT_WORKBENCH_PROJECT_ROOT: projectRoot,
          SMRT_WORKBENCH_PACKAGE: '@happyvertical/smrt-content',
          SMRT_WORKBENCH_ALLOW_REMOTE: '1',
        }),
      }),
    );
  });

  it('rejects when the workbench host cannot be started', async () => {
    spawnMock.mockImplementationOnce(
      () =>
        ({
          on: (event: string, cb: (error: Error) => void) => {
            if (event === 'error') {
              setTimeout(() => cb(new Error('spawn failed')), 0);
            }
          },
        }) as never,
    );

    await expect(
      (await loadCommands())['workbench:dev'].handler([], {}),
    ).rejects.toThrow('spawn failed');
  });

  it('requires explicit acknowledgement before binding remotely', async () => {
    await expect(
      (await loadCommands())['workbench:dev'].handler([], {
        host: '0.0.0.0',
      }),
    ).rejects.toThrow('Refusing to expose the workbench');

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    '0',
    '65536',
    '1.5',
    '5570 & calc',
  ])('rejects invalid workbench port %s', async (port) => {
    await expect(
      (await loadCommands())['workbench:dev'].handler([], { port }),
    ).rejects.toThrow('Expected an integer from 1 to 65535');

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the Windows command shim without enabling a shell', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const execPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'execPath',
    );
    const originalNpmExecPath = process.env.npm_execpath;
    const windowsNode = join(projectRoot, 'node.exe');
    const corepackEntry = join(
      projectRoot,
      'node_modules',
      'corepack',
      'dist',
      'pnpm.js',
    );
    mkdirSync(join(projectRoot, 'node_modules', 'corepack', 'dist'), {
      recursive: true,
    });
    writeFileSync(windowsNode, '');
    writeFileSync(corepackEntry, '');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: windowsNode,
    });
    delete process.env.npm_execpath;

    try {
      await (await loadCommands())['workbench:dev'].handler([], {
        port: '5570',
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (execPathDescriptor) {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = originalNpmExecPath;
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      windowsNode,
      expect.arrayContaining([corepackEntry, '--port', '5570']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('resolves a global pnpm cmd shim without enabling a shell', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const execPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'execPath',
    );
    const originalNpmExecPath = process.env.npm_execpath;
    const windowsNode = join(projectRoot, 'node.exe');
    const pnpmShim = join(projectRoot, 'pnpm.cmd');
    const pnpmCli = join(
      projectRoot,
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    );
    mkdirSync(join(projectRoot, 'node_modules', 'pnpm', 'bin'), {
      recursive: true,
    });
    writeFileSync(windowsNode, '');
    writeFileSync(pnpmCli, '');
    writeFileSync(
      pnpmShim,
      '@"%dp0%\\node.exe" "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\n',
    );
    execFileSyncMock.mockReturnValue(`${pnpmShim}\r\n`);
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: windowsNode,
    });
    delete process.env.npm_execpath;

    try {
      await (await loadCommands())['workbench:dev'].handler([], {
        port: '5570',
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (execPathDescriptor) {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = originalNpmExecPath;
      }
    }

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'where.exe',
      ['pnpm.cmd'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      windowsNode,
      expect.arrayContaining([pnpmCli, '--port', '5570']),
      expect.objectContaining({ shell: false }),
    );

    spawnMock.mockClear();
    const attackerRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'smrt-workbench-attacker-')),
    );
    const attackerCli = join(attackerRoot, 'pnpm.cjs');
    writeFileSync(attackerCli, '');
    writeFileSync(
      pnpmShim,
      `@"%dp0%\\node.exe" "%dp0%\\..\\${basename(attackerRoot)}\\pnpm.cjs" %*\n`,
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: windowsNode,
    });
    try {
      await (await loadCommands())['workbench:dev'].handler([], {
        port: '5571',
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (execPathDescriptor) {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
      rmSync(attackerRoot, { recursive: true, force: true });
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm.exe',
      expect.arrayContaining(['--port', '5571']),
      expect.objectContaining({ shell: false }),
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      windowsNode,
      expect.arrayContaining([attackerCli]),
      expect.anything(),
    );
  });

  it('formats an IPv6 loopback address as a valid display URL', async () => {
    await (await loadCommands())['workbench:dev'].handler([], {
      host: '::1',
      port: '5570',
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://[::1]:5570/'),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['--host', '::1']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('explains the node-modules requirement for Yarn Plug’n’Play', async () => {
    rmSync(join(projectRoot, 'packages'), { recursive: true, force: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      '{"name":"pnp-consumer","packageManager":"yarn@4.9.2"}\n',
    );
    writeFileSync(join(projectRoot, '.pnp.cjs'), 'module.exports = {};\n');
    process.chdir(projectRoot);

    await expect(
      (await loadCommands())['workbench:dev'].handler([], {}),
    ).rejects.toThrow('nodeLinker: node-modules');

    expect(importWorkspaceModuleMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('starts the installed host with the consumer package manager', async () => {
    rmSync(join(projectRoot, 'packages'), { recursive: true, force: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      '{"name":"consumer-app","type":"module"}\n',
    );
    const installedRoot = join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-workbench',
    );
    mkdirSync(join(installedRoot, 'dist'), { recursive: true });
    mkdirSync(join(installedRoot, 'host'), { recursive: true });
    writeFileSync(
      join(installedRoot, 'package.json'),
      '{"name":"@happyvertical/smrt-workbench","type":"module"}\n',
    );
    writeFileSync(
      join(installedRoot, 'host', 'package.json'),
      '{"name":"smrt-workbench-host"}\n',
    );
    writeFileSync(
      join(installedRoot, 'dist', 'index.js'),
      `export function resolveWorkbenchScope(cwd) {
  return { mode: 'consumer', cwd, projectRoot: cwd };
}
`,
    );
    process.chdir(projectRoot);

    const commands = await loadCommands();
    await commands['workbench:dev'].handler([], {
      host: '127.0.0.1',
      port: '5570',
    });

    expect(importWorkspaceModuleMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      [
        '--prefix',
        join(installedRoot, 'host'),
        'run',
        'dev',
        '--',
        '--host',
        '127.0.0.1',
        '--port',
        '5570',
      ],
      expect.objectContaining({
        cwd: projectRoot,
        env: expect.objectContaining({
          SMRT_WORKBENCH_PROJECT_ROOT: projectRoot,
        }),
      }),
    );

    spawnMock.mockClear();
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const execPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'execPath',
    );
    const originalNpmExecPath = process.env.npm_execpath;
    const windowsNode = join(projectRoot, 'node.exe');
    const npmCli = join(
      projectRoot,
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    mkdirSync(join(projectRoot, 'node_modules', 'npm', 'bin'), {
      recursive: true,
    });
    writeFileSync(windowsNode, '');
    writeFileSync(npmCli, '');
    const unrelatedPnpmExecPath = join(projectRoot, 'pnpm.cjs');
    writeFileSync(unrelatedPnpmExecPath, '');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: windowsNode,
    });
    process.env.npm_execpath = unrelatedPnpmExecPath;

    try {
      await commands['workbench:dev'].handler([], {
        host: '127.0.0.1',
        port: '5573',
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (execPathDescriptor) {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = originalNpmExecPath;
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      windowsNode,
      [
        npmCli,
        '--prefix',
        join(installedRoot, 'host'),
        'run',
        'dev',
        '--',
        '--host',
        '127.0.0.1',
        '--port',
        '5573',
      ],
      expect.objectContaining({ cwd: projectRoot, shell: false }),
    );

    spawnMock.mockClear();
    writeFileSync(join(projectRoot, 'yarn.lock'), '');
    await commands['workbench:dev'].handler([], {
      host: '127.0.0.1',
      port: '5571',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'yarn',
      [
        '--cwd',
        join(installedRoot, 'host'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        '5571',
      ],
      expect.objectContaining({ cwd: projectRoot }),
    );

    spawnMock.mockClear();
    const nestedProjectRoot = join(projectRoot, 'apps', 'consumer');
    mkdirSync(nestedProjectRoot, { recursive: true });
    writeFileSync(
      join(nestedProjectRoot, 'package.json'),
      '{"name":"nested-consumer","type":"module"}\n',
    );
    writeFileSync(
      join(projectRoot, 'pnpm-lock.yaml'),
      'lockfileVersion: "9.0"\n',
    );
    process.chdir(nestedProjectRoot);
    await commands['workbench:dev'].handler([], {
      host: '127.0.0.1',
      port: '5572',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      [
        '--dir',
        join(installedRoot, 'host'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        '5572',
      ],
      expect.objectContaining({ cwd: nestedProjectRoot }),
    );
  });
});
