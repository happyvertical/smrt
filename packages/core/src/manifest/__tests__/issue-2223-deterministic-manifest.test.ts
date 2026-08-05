/**
 * Regression tests for Issue #2223 — build output must be reproducible.
 *
 * Manifests are inlined verbatim into every package bundle
 * (`registerPackageManifest(JSON.parse("…"))`), and knowledge artifacts are
 * emitted into `dist/`. Any wall-clock value in either changes the emitted
 * bytes on every build, which changes Vite's content hash, which changes
 * `dist/`, which invalidates downstream Turbo tasks through
 * `dependsOn: ['^build']`. Measured before the fix: one rebuilt package
 * churned 202 of 245 task hashes, and `typecheck` never reused a cache entry
 * across runs (11/118 cold, 16/118 warm, no time saved).
 */
import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_GENERATED_AT,
  MANIFEST_TIMESTAMP,
} from '../../scanner/types.js';
import { createEmptyStaticManifest } from '../store.js';

describe('Issue #2223 - deterministic build output', () => {
  it('pins the manifest timestamp to a fixed value', () => {
    expect(MANIFEST_TIMESTAMP).toBe(0);
  });

  it('pins the emitted knowledge generatedAt to a parseable fixed instant', () => {
    expect(DETERMINISTIC_GENERATED_AT).toBe('1970-01-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(DETERMINISTIC_GENERATED_AT))).toBe(false);
  });

  it('generates byte-identical empty manifests across calls', () => {
    const first = JSON.stringify(createEmptyStaticManifest());
    const second = JSON.stringify(createEmptyStaticManifest());

    expect(second).toBe(first);
  });

  it('keeps the manifest timestamp stable across a clock advance', () => {
    const before = createEmptyStaticManifest().timestamp;
    const start = Date.now();
    while (Date.now() === start) {
      // Spin until the wall clock ticks, so a Date.now()-based
      // implementation is guaranteed to produce a different value.
    }

    expect(createEmptyStaticManifest().timestamp).toBe(before);
  });
});
