/**
 * Per-package browser capability table (#3709).
 *
 * Derives the table from the browser gate's expected-failures ratchet and the
 * packages' dependencies, and checks that the copy generated into smrt-core
 * (which every manifest build reads) is current. Needs no bundle, so it is
 * fast. After changing `expected-failures.ts` or a model package's
 * dependencies, regenerate with:
 *
 *   UPDATE_BROWSER_CAPABILITY=1 pnpm --filter @happyvertical/smrt-bundle-gate test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverModelPackages } from '../browser-gate/boundary.js';
import {
  CAPABILITY_TABLE_PATH,
  deriveBrowserCapabilities,
  readCapabilityInputs,
  renderCapabilityModule,
} from '../browser-gate/capability.js';
import { EXPECTED_BROWSER_FAILURES } from '../browser-gate/expected-failures.js';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('deriveBrowserCapabilities', () => {
  const pkg = (name: string, ...dependencies: string[]) => ({
    name,
    dependencies,
  });
  const expected = {
    '@happyvertical/smrt-core': { issue: '#1, #2', reason: 'platform' },
    '@x/tenancy': { issue: '#3624', reason: 'node:async_hooks' },
    '@x/chat': { issue: '#3624, #3625', reason: 'node:crypto' },
  };

  it('marks a listed package server-only with its issues and reason', () => {
    const table = deriveBrowserCapabilities([pkg('@x/tenancy')], expected);
    expect(table['@x/tenancy']).toEqual({
      status: 'server-only',
      issues: ['#3624'],
      reason: 'node:async_hooks',
    });
  });

  it('marks an unlisted package with no failing dependency browser-safe', () => {
    const table = deriveBrowserCapabilities(
      [pkg('@x/tags', '@happyvertical/smrt-core', 'left-pad')],
      expected,
    );
    expect(table['@x/tags']).toEqual({ status: 'browser-safe' });
  });

  it('inherits server-only through transitive workspace dependencies', () => {
    const table = deriveBrowserCapabilities(
      [
        pkg('@x/tenancy'),
        pkg('@x/tags', '@x/tenancy'),
        pkg('@x/blog', '@x/tags'),
        pkg('@x/chat', '@x/tenancy'),
      ],
      expected,
    );
    expect(table['@x/blog']).toEqual({
      status: 'server-only',
      issues: ['#3624'],
      via: ['@x/tenancy'],
    });
    // Own failure and an inherited one are both reported.
    expect(table['@x/chat']).toEqual({
      status: 'server-only',
      issues: ['#3624', '#3625'],
      reason: 'node:crypto',
      via: ['@x/tenancy'],
    });
  });

  it('does not propagate the platform baseline, but reports it', () => {
    const table = deriveBrowserCapabilities(
      [
        pkg('@happyvertical/smrt-core'),
        pkg('@x/tags', '@happyvertical/smrt-core'),
      ],
      expected,
    );
    expect(table['@happyvertical/smrt-core']?.status).toBe('server-only');
    expect(table['@x/tags']).toEqual({ status: 'browser-safe' });
  });

  it('terminates on dependency cycles', () => {
    const table = deriveBrowserCapabilities(
      [
        pkg('@x/a', '@x/b'),
        pkg('@x/b', '@x/a', '@x/tenancy'),
        pkg('@x/tenancy'),
      ],
      expected,
    );
    expect(table['@x/a']?.via).toEqual(['@x/tenancy']);
  });
});

describe('generated browser capability table', () => {
  it('is current', () => {
    const packages = discoverModelPackages(workspaceRoot);
    const table = deriveBrowserCapabilities(
      readCapabilityInputs(packages),
      EXPECTED_BROWSER_FAILURES,
    );
    const expected = renderCapabilityModule(table);
    const file = path.resolve(workspaceRoot, CAPABILITY_TABLE_PATH);

    if (process.env.UPDATE_BROWSER_CAPABILITY === '1') {
      writeFileSync(file, expected);
    }
    expect(
      readFileSync(file, 'utf8'),
      `${CAPABILITY_TABLE_PATH} is stale; regenerate with UPDATE_BROWSER_CAPABILITY=1 pnpm --filter @happyvertical/smrt-bundle-gate test`,
    ).toBe(expected);
  });
});
