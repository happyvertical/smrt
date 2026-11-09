import { describe, expect, it } from 'vitest';
import {
  BUNDLE_EXIT_CODES,
  BundleError,
  type BundleErrorCode,
  bundleExitCode,
  bundleFailureDocument,
} from './errors.js';
import { NativeVerificationError } from './native/errors.js';
import type { NodeDistErrorCode } from './node-errors.js';
import { NODE_DIST_MESSAGES, NodeDistError } from './node-errors.js';
import type { TreeErrorCode } from './tree-errors.js';
import { BundleTreeError, TREE_ERROR_MESSAGE_TABLE } from './tree-errors.js';

describe('exit code table', () => {
  it('is the documented closed table', () => {
    expect(BUNDLE_EXIT_CODES).toEqual({
      ok: 0,
      internal: 1,
      usage: 2,
      invalid_input: 3,
      provenance: 4,
      verification: 5,
      budget: 6,
      child_failed: 7,
      io: 8,
    });
    expect(Object.isFrozen(BUNDLE_EXIT_CODES)).toBe(true);
    expect(new Set(Object.values(BUNDLE_EXIT_CODES)).size).toBe(9);
  });

  it('maps every node distribution code to the exit of its category', () => {
    const expected = {
      usage: 2,
      provenance: 4,
      verification: 5,
      io: 8,
    } as const;
    for (const code of Object.keys(NODE_DIST_MESSAGES) as NodeDistErrorCode[]) {
      const original = new NodeDistError(code);
      const wrapped = BundleError.from(original);
      expect(wrapped.code).toBe(code);
      expect(wrapped.message).toBe(original.message);
      expect(wrapped.exitCode).toBe(expected[original.category]);
      expect(bundleExitCode(original)).toBe(wrapped.exitCode);
    }
  });

  it('maps every tree code to the exit of its category', () => {
    const expected = {
      usage: 2,
      invalid_input: 3,
      verification: 5,
      io: 8,
    } as const;
    for (const code of Object.keys(
      TREE_ERROR_MESSAGE_TABLE,
    ) as TreeErrorCode[]) {
      const original = new BundleTreeError(code, {
        field: 'f',
        subjects: ['x'],
      });
      const wrapped = BundleError.from(original, 'segment');
      expect(wrapped.code).toBe(code);
      expect(wrapped.message).toBe(original.message);
      expect(wrapped.exitCode).toBe(expected[original.category]);
      expect(wrapped.field).toBe('f');
      expect(wrapped.subjects).toEqual(['x']);
      expect(wrapped.stage).toBe('segment');
    }
  });

  it('maps native verification errors to usage, invalid input, verification or io', () => {
    expect(
      bundleExitCode(new NativeVerificationError('unsupported_target')),
    ).toBe(2);
    expect(
      bundleExitCode(new NativeVerificationError('invalid_exception')),
    ).toBe(3);
    expect(bundleExitCode(new NativeVerificationError('malformed'))).toBe(5);
    expect(bundleExitCode(new NativeVerificationError('read_failed'))).toBe(8);
    const failed = BundleError.from(
      new NativeVerificationError('verification_failed', [
        { path: 'resources/app/x.node', reason: 'wrong_machine' },
      ]),
    );
    expect(failed.exitCode).toBe(5);
    expect(failed.failures).toEqual([
      { path: 'resources/app/x.node', reason: 'wrong_machine' },
    ]);
    expect(failed.subjects).toEqual(['resources/app/x.node']);
  });

  it('gives the orchestrator codes their documented exits', () => {
    const table: [BundleErrorCode, number][] = [
      ['measure_needs_host_target', 2],
      ['bridge_missing', 3],
      ['lockfile_drift', 4],
      ['integrity_failure', 4],
      ['lockfile_non_registry', 4],
      ['bridge_not_self_contained', 5],
      ['build_step_required', 5],
      ['manifest_round_trip', 5],
      ['size_budget_exceeded', 6],
      ['pnpm_failed', 7],
      ['smoke_start_failed', 7],
      ['internal', 1],
    ];
    for (const [code, exit] of table) {
      expect(new BundleError(code).exitCode, code).toBe(exit);
    }
  });

  it('turns anything unrecognised into an internal error without its text', () => {
    const error = BundleError.from(new Error('/Users/me/.npmrc token=abc'));
    expect(error.code).toBe('internal');
    expect(error.exitCode).toBe(1);
    expect(error.message).not.toContain('abc');
    expect(bundleExitCode('a string')).toBe(1);
    expect(bundleExitCode(undefined)).toBe(1);
  });

  it('keeps the first stage and caps the subjects', () => {
    const first = BundleError.from(new BundleTreeError('io_failed'), 'install');
    expect(BundleError.from(first, 'publish').stage).toBe('install');
    const many = new BundleError('build_step_required', {
      subjects: Array.from({ length: 100 }, (_, i) => `p${i}`),
    });
    expect(many.subjects).toHaveLength(20);
  });

  it('describes a failure as a value-free JSON document', () => {
    const document = bundleFailureDocument(
      new BundleError('lockfile_drift', { stage: 'install' }),
    );
    expect(document).toEqual({
      ok: false,
      code: 'lockfile_drift',
      category: 'provenance',
      exitCode: 4,
      stage: 'install',
      message:
        'pnpm-lock.yaml does not match package.json, so the frozen install was refused',
    });
    expect(bundleFailureDocument(new Error('x')).stage).toBeNull();
    expect(document).not.toHaveProperty('report');
    const report = { files: { bytes: 1 } } as never;
    expect(
      bundleFailureDocument(
        new BundleError('size_budget_exceeded', { report }),
      ),
    ).toHaveProperty('report', report);
  });
});
