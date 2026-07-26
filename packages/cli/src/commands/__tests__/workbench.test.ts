import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { importWorkspaceModuleMock, spawnMock } = vi.hoisted(() => ({
  importWorkspaceModuleMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core/utils/import-workspace-module', () => ({
  importWorkspaceModule: importWorkspaceModuleMock,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
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
