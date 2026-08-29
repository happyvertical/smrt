import { describe, expect, it } from 'vitest';
import {
  getApplicationRuntimePreset,
  RuntimeProfileValidationError,
  resolveApplicationRuntime,
} from './index.js';

describe('application runtime profiles', () => {
  it.each([
    {
      profile: 'local' as const,
      engine: 'sqlite',
      auth: 'owner-bootstrap',
      assets: 'local-files',
      secrets: 'local-file',
      jobs: 'embedded',
      exposure: 'loopback',
    },
    {
      profile: 'self-hosted' as const,
      engine: 'postgres',
      auth: 'oidc',
      assets: 's3-compatible',
      secrets: 'environment',
      jobs: 'external',
      exposure: 'public',
    },
    {
      profile: 'cloud' as const,
      engine: 'postgres',
      auth: 'hosted-identity',
      assets: 'managed-object-storage',
      secrets: 'managed',
      jobs: 'scalable',
      exposure: 'public',
    },
  ])('resolves the minimal $profile config into explicit providers', ({
    profile,
    engine,
    auth,
    assets,
    secrets,
    jobs,
    exposure,
  }) => {
    const resolved = resolveApplicationRuntime({ profile });

    expect(resolved.schemaVersion).toBe(1);
    expect(resolved.providers.database.engine).toBe(engine);
    expect(resolved.providers.authentication.provider).toBe(auth);
    expect(resolved.providers.assets.provider).toBe(assets);
    expect(resolved.providers.secrets.provider).toBe(secrets);
    expect(resolved.providers.jobs.topology).toBe(jobs);
    expect(resolved.providers.network.exposure).toBe(exposure);
    expect(resolved.providers.portability).toMatchObject({
      logicalExport: true,
      logicalImport: true,
    });
    expect(resolved.diagnostics).toEqual({
      secretValuesIncluded: false,
      overrides: [],
      unsafeOverrides: [],
    });
  });

  it('accepts safe provider overrides and reports them canonically', () => {
    const resolved = resolveApplicationRuntime({
      profile: 'self-hosted',
      providers: {
        tenancy: { context: 'required', mode: 'multi-tenant' },
        authentication: { provider: 'magic-link' },
        assets: { provider: 'local-files' },
      },
    });

    expect(resolved.providers.authentication.provider).toBe('magic-link');
    expect(resolved.capabilities.multiTenant).toBe(true);
    expect(resolved.capabilities.localAssets).toBe(true);
    expect(resolved.diagnostics.overrides).toEqual([
      {
        path: 'providers.authentication.provider',
        from: 'oidc',
        to: 'magic-link',
      },
      {
        path: 'providers.tenancy.mode',
        from: 'single-tenant',
        to: 'multi-tenant',
      },
      {
        path: 'providers.tenancy.context',
        from: 'defaulted',
        to: 'required',
      },
      {
        path: 'providers.assets.provider',
        from: 's3-compatible',
        to: 'local-files',
      },
    ]);
  });

  it('fails closed with actionable issues before startup', () => {
    expect(() =>
      resolveApplicationRuntime({
        profile: 'local',
        providers: {
          network: { exposure: 'public' },
          authentication: { ownerBootstrap: 'disabled' },
        },
      }),
    ).toThrowError(RuntimeProfileValidationError);

    try {
      resolveApplicationRuntime({
        profile: 'local',
        providers: {
          network: { exposure: 'public' },
          authentication: { ownerBootstrap: 'disabled' },
        },
      });
    } catch (error) {
      const validation = error as RuntimeProfileValidationError;
      expect(validation.issues.map((issue) => issue.path)).toEqual([
        'providers.authentication.ownerBootstrap',
        'providers.network.exposure',
      ]);
      expect(validation.message).toContain('Recovery:');
      expect(validation.message).toContain('select a different profile');
    }
  });

  it('does not let provider overrides change surface or approval invariants', () => {
    expect(() =>
      resolveApplicationRuntime({
        profile: 'cloud',
        providers: {
          // The runtime guard must reject policy fields even from JS/JSON input.
          webmcp: { effectPolicy: 'allow-all' },
        },
      } as never),
    ).toThrow(/providers\.webmcp.*not an overridable infrastructure provider/s);

    const local = resolveApplicationRuntime({ profile: 'local' });
    const cloud = resolveApplicationRuntime({ profile: 'cloud' });
    expect(local.invariants).toEqual(cloud.invariants);
    expect(local.invariants).toMatchObject({
      generatedMcp: 'identical',
      generatedWebMcp: 'identical',
      mcpExposurePolicy: 'identical',
      webMcpExposurePolicy: 'identical',
      actionEffects: 'identical',
      approvalPolicy: 'identical',
    });
  });

  it('rejects inherited provider names instead of treating them as selectors', () => {
    const config = JSON.parse(
      '{"profile":"local","providers":{"toString":{"topology":"inline"}}}',
    );
    expect(() => resolveApplicationRuntime(config)).toThrow(
      /providers\.toString.*not an overridable infrastructure provider/s,
    );
  });

  it('returns deterministic, deeply frozen, secret-free snapshots', () => {
    const first = resolveApplicationRuntime({
      profile: 'self-hosted',
      providers: {
        assets: { provider: 'local-files' },
        authentication: { provider: 'magic-link' },
      },
    });
    const second = resolveApplicationRuntime({
      providers: {
        authentication: { provider: 'magic-link' },
        assets: { provider: 'local-files' },
      },
      profile: 'self-hosted',
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain('do-not-leak');
    expect(first.diagnostics.secretValuesIncluded).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.providers.database)).toBe(true);
    expect(Object.isFrozen(first.diagnostics.overrides)).toBe(true);
  });

  it('never echoes invalid secret-like input values in diagnostics', () => {
    const credential = 'postgresql://will:do-not-leak@example.com/app';
    try {
      resolveApplicationRuntime({
        profile: 'local',
        providers: { database: { engine: credential } },
      } as never);
      throw new Error('expected runtime validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeProfileValidationError);
      expect(String(error)).not.toContain(credential);
      expect(JSON.stringify(error)).not.toContain(credential);
    }
  });

  it('returns independent preset snapshots', () => {
    const first = getApplicationRuntimePreset('local');
    const second = getApplicationRuntimePreset('local');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
