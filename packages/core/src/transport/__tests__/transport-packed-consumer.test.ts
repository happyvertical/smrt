/**
 * `./transport` and `./error-contract` as an installed consumer sees them
 * (#5158).
 *
 * Emitted routes and servers will import both subpaths from the published
 * package, so the checks run against the packed tarball in a clean pnpm
 * consumer, with no workspace alias in sight: both subpaths resolve, they
 * belong to the one installed copy of the package, the error contract module
 * still imports nothing after the build, and the declarations type-check.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = resolve(import.meta.dirname, '../../..');
const workspaceRoot = resolve(packageDir, '../..');

interface PackedConsumer {
  directory: string;
  cleanup: () => void;
}

interface PackedConsumerModule {
  createPackedConsumer(input: {
    root: string;
    packageNames: string[];
  }): PackedConsumer;
}

interface ConsumerReport {
  sameTable: boolean;
  samePublicError: boolean;
  sameRegistry: boolean;
  rootKernelNames: string[];
  operations: string[];
  surfaces: string[];
  transports: string[];
  stubError: string;
  brandAcrossSubpaths: boolean;
  entries: { root: string; contract: string; kernel: string };
}

describe('transport kernel packed consumer', () => {
  let consumer: PackedConsumer | undefined;
  let report: ConsumerReport;

  const consumerDir = () => {
    if (!consumer) throw new Error('Packed consumer was not created');
    return consumer.directory;
  };
  const installedCore = () =>
    join(consumerDir(), 'node_modules/@happyvertical/smrt-core');

  beforeAll(async () => {
    const { createPackedConsumer } = (await import(
      pathToFileURL(resolve(workspaceRoot, 'scripts/packed-consumer.mjs')).href
    )) as PackedConsumerModule;
    consumer = createPackedConsumer({
      root: workspaceRoot,
      packageNames: ['@happyvertical/smrt-core'],
    });

    const script = join(consumer.directory, 'transport-kernel.mjs');
    writeFileSync(
      script,
      `import * as root from '@happyvertical/smrt-core';
import * as contract from '@happyvertical/smrt-core/error-contract';
import * as kernel from '@happyvertical/smrt-core/transport';

let stubError = '';
try {
  kernel.executeOperation();
} catch (error) {
  stubError = error instanceof kernel.TransportNotImplementedError ? error.feature : String(error);
}
root.registerErrorCodes({ PACKED_CONSUMER_PROBE: { status: 409, message: 'fixed', text: 'Probe.' } });

console.log(JSON.stringify({
  sameTable: root.ERROR_CONTRACT === contract.ERROR_CONTRACT,
  samePublicError: root.publicError === contract.publicError,
  sameRegistry: contract.getErrorContract('PACKED_CONSUMER_PROBE')?.status === 409,
  rootKernelNames: Object.keys(kernel).filter((name) => name in root),
  operations: kernel.TRANSPORT_OPERATIONS,
  surfaces: kernel.TRANSPORT_SURFACES,
  transports: Object.keys(kernel.LEGACY_PROFILES),
  stubError,
  brandAcrossSubpaths: root.isPublicError(contract.publicError(403, 'PROBE', 'Probe.')),
  entries: {
    root: import.meta.resolve('@happyvertical/smrt-core'),
    contract: import.meta.resolve('@happyvertical/smrt-core/error-contract'),
    kernel: import.meta.resolve('@happyvertical/smrt-core/transport'),
  },
}));
`,
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: consumer.directory,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90_000,
    });
    expect(result.error, String(result.stderr)).toBeUndefined();
    expect(result.status, String(result.stderr)).toBe(0);
    report = JSON.parse(
      String(result.stdout).trim().split('\n').at(-1) ?? '',
    ) as ConsumerReport;
  }, 240_000);

  afterAll(() => {
    consumer?.cleanup();
    consumer = undefined;
  });

  it('resolves both subpaths inside the one installed copy of the package', () => {
    const { root, contract, kernel } = report.entries;
    const base = root.slice(0, root.lastIndexOf('/dist/'));
    expect(base).toContain(`${consumerDir()}/node_modules/.pnpm/`);
    expect(contract).toBe(`${base}/dist/error-contract.js`);
    expect(kernel).toBe(`${base}/dist/transport.js`);
    const copies = readdirSync(
      join(consumerDir(), 'node_modules/.pnpm'),
    ).filter((name) => name.startsWith('@happyvertical+smrt-core@'));
    expect(copies).toHaveLength(1);
  });

  it('shares one error contract between the root and the subpath', () => {
    expect(report.sameTable).toBe(true);
    expect(report.samePublicError).toBe(true);
    expect(report.sameRegistry).toBe(true);
    expect(report.brandAcrossSubpaths).toBe(true);
  });

  it('publishes the kernel on its subpath only', () => {
    expect(report.rootKernelNames).toEqual([]);
    expect(report.operations).toEqual([
      'list',
      'get',
      'count',
      'create',
      'update',
      'delete',
    ]);
    expect(report.surfaces).toEqual([
      'rest',
      'mcp',
      'sync',
      'cli',
      'assistant',
    ]);
    expect(report.transports).toHaveLength(9);
    expect(report.stubError).toBe('transport.executeOperation');
  });

  it('ships an error contract module that still imports nothing', () => {
    const built = readFileSync(
      join(installedCore(), 'dist/error-contract.js'),
      'utf8',
    );
    expect(built).not.toMatch(/^\s*import\s/m);
    expect(built).not.toMatch(/\bfrom\s+['"]/);
    expect(built).not.toMatch(/\b(require|import)\s*\(/);
  });

  it('ships declarations a strict consumer can compile against', () => {
    for (const file of [
      'dist/error-contract.d.ts',
      'dist/transport.d.ts',
      'dist/transport/types.d.ts',
      'dist/transport/profile.d.ts',
    ]) {
      expect(existsSync(join(installedCore(), file)), file).toBe(true);
    }
    writeFileSync(
      join(consumerDir(), 'transport-kernel-types.ts'),
      `import {
  type ErrorContractEntry,
  getErrorContract,
  publicError,
} from '@happyvertical/smrt-core/error-contract';
import {
  type CrudOperation,
  LEGACY_REST,
  type Principal,
  TRANSPORT_OPERATIONS,
  type TransportBinding,
  type TransportProfile,
  executeOperation,
} from '@happyvertical/smrt-core/transport';

const entry: ErrorContractEntry | undefined = getErrorContract('NOT_FOUND');
const status: number = publicError(404, 'NOT_FOUND', entry?.text ?? 'x').status;
const operations: readonly CrudOperation[] = TRANSPORT_OPERATIONS;
const profile: TransportProfile = LEGACY_REST;
const principal: Principal = {
  authenticated: false,
  permissions: new Set<string>(),
  fieldPermissions: new Set<string>(),
};
declare const binding: TransportBinding;
export const pending = executeOperation(binding, principal, 'get', { id: 'a' });
// @ts-expect-error a get takes an id, not a body
executeOperation(binding, principal, 'get', { body: {} });
// @ts-expect-error a principal must state its field permissions
const incomplete: Principal = { authenticated: true, permissions: 'all' };
export { incomplete, operations, profile, status };
`,
    );
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        'transport-kernel-types.ts',
      ],
      { cwd: consumerDir(), encoding: 'utf8', timeout: 120_000 },
    );
    expect(
      result.status,
      `${String(result.stdout)}${String(result.stderr)}`,
    ).toBe(0);
  }, 150_000);
});
