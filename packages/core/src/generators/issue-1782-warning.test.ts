/**
 * Unit coverage for issue #1782's registration/generation-time warning:
 * `warnIfTenantScopedPublicRead`.
 *
 * The tenant-scoped + `api.public` combination is a footgun — anonymous reads
 * fail closed to global rows only — so the framework surfaces it once per model
 * wherever the model is exposed. This asserts exactly when the warning fires
 * (and that it dedups), without a live server or generator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnIfTenantScopedPublicRead } from './conditional-get';

describe('#1782: warnIfTenantScopedPublicRead', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns for a tenant-scoped model with api.public: "read"', () => {
    warnIfTenantScopedPublicRead('M1', { public: 'read' }, true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('#1782');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('M1');
  });

  it('warns for a tenant-scoped model with api.public: true', () => {
    warnIfTenantScopedPublicRead('M2', { public: true }, true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the model is not tenant-scoped', () => {
    warnIfTenantScopedPublicRead('M3', { public: 'read' }, false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when the model is tenant-scoped but not public', () => {
    warnIfTenantScopedPublicRead('M4', { public: false }, true);
    warnIfTenantScopedPublicRead('M4b', {}, true);
    warnIfTenantScopedPublicRead('M4c', undefined, true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns at most once per model', () => {
    warnIfTenantScopedPublicRead('M5', { public: 'read' }, true);
    warnIfTenantScopedPublicRead('M5', { public: 'read' }, true);
    warnIfTenantScopedPublicRead('M5', { public: true }, true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
