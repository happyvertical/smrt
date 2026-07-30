/**
 * Regression guard for the build-time manifest scan excludes (#2146).
 *
 * `@smrt()` classes declared in test files must never reach a published
 * `dist/manifest.json`: the smrt-app-mcp conformance fixtures leaked into
 * the production manifest as phantom package objects because the plugin's
 * default exclude list had drifted from the scanner package's defaults and
 * missed `__tests__` directories (test FILES were excluded, plain fixture
 * modules inside `__tests__/` were not).
 */
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_EXCLUDE } from './index.js';

function isExcluded(path: string): boolean {
  return DEFAULT_SCAN_EXCLUDE.some((pattern) =>
    minimatch(path, pattern, { dot: true }),
  );
}

describe('DEFAULT_SCAN_EXCLUDE (build-time manifest scan)', () => {
  it('excludes every test-file shape that can declare @smrt() classes', () => {
    expect(isExcluded('src/registry.test.ts')).toBe(true);
    expect(isExcluded('src/generators/mcp-protocol.spec.ts')).toBe(true);
    expect(isExcluded('src/__tests__/mcp-conformance-fixture-objects.ts')).toBe(
      true,
    );
    expect(isExcluded('src/__tests__/fixtures/registry-test-classes.ts')).toBe(
      true,
    );
    expect(isExcluded('node_modules/pkg/src/model.ts')).toBe(true);
  });

  it('keeps production sources in scan scope', () => {
    expect(isExcluded('src/models/article.ts')).toBe(false);
    expect(isExcluded('src/testing/database.ts')).toBe(false);
    expect(isExcluded('src/index.ts')).toBe(false);
  });
});
