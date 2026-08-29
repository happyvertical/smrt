/**
 * Stable application-runtime profile contract.
 *
 * Profiles select infrastructure composition only. Domain models, generated
 * surfaces, effect metadata, and approval policy are deliberately outside the
 * override surface so moving an application cannot silently change behavior.
 */

export type ApplicationRuntimeProfile = 'local' | 'self-hosted' | 'cloud';

export type DatabaseEngine = 'sqlite' | 'postgres';
export type ConnectionOwnership = 'user' | 'operator' | 'managed';
export type AuthenticationProvider =
  | 'owner-bootstrap'
  | 'oidc'
  | 'magic-link'
  | 'hosted-identity';
export type OwnerBootstrapMode = 'single-use' | 'disabled';
export type TenancyMode = 'default-tenant' | 'single-tenant' | 'multi-tenant';
export type TenantContextMode = 'defaulted' | 'required';
export type TenantIsolation = 'application' | 'database-rls';
export type AssetStorageProvider =
  | 'local-files'
  | 's3-compatible'
  | 'managed-object-storage';
export type AssetOwnership = 'user' | 'operator' | 'managed';
export type SecretProvider =
  | 'local-file'
  | 'environment'
  | 'external'
  | 'managed';
export type SecretOwnership = 'user' | 'operator' | 'managed';
export type JobTopology = 'inline' | 'embedded' | 'external' | 'scalable';
export type NetworkExposure = 'loopback' | 'public';
export type BackupProvider = 'file-snapshot' | 'operator' | 'managed';

export interface RuntimeDatabaseProvider {
  readonly engine: DatabaseEngine;
  readonly connectionOwnership: ConnectionOwnership;
}

export interface RuntimeAuthenticationProvider {
  readonly provider: AuthenticationProvider;
  readonly ownerBootstrap: OwnerBootstrapMode;
}

export interface RuntimeTenancyProvider {
  readonly mode: TenancyMode;
  readonly context: TenantContextMode;
  readonly isolation: TenantIsolation;
}

export interface RuntimeAssetProvider {
  readonly provider: AssetStorageProvider;
  readonly ownership: AssetOwnership;
}

export interface RuntimeSecretProvider {
  readonly provider: SecretProvider;
  readonly ownership: SecretOwnership;
}

export interface RuntimeJobProvider {
  readonly topology: JobTopology;
}

export interface RuntimeNetworkProvider {
  readonly exposure: NetworkExposure;
  readonly tls: boolean;
}

export interface RuntimePortabilityProvider {
  readonly backup: BackupProvider;
  readonly logicalExport: true;
  readonly logicalImport: true;
}

/** Fully selected infrastructure providers for an application runtime. */
export interface RuntimeProviders {
  readonly database: RuntimeDatabaseProvider;
  readonly authentication: RuntimeAuthenticationProvider;
  readonly tenancy: RuntimeTenancyProvider;
  readonly assets: RuntimeAssetProvider;
  readonly secrets: RuntimeSecretProvider;
  readonly jobs: RuntimeJobProvider;
  readonly network: RuntimeNetworkProvider;
  readonly portability: RuntimePortabilityProvider;
}

/**
 * Explicit provider changes layered over a profile's safe preset.
 *
 * Every override is revalidated with the completed composition. Capability and
 * surface-policy fields are intentionally absent: providers cannot use this
 * seam to weaken cross-profile invariants.
 */
export interface RuntimeProviderOverrides {
  database?: Partial<RuntimeDatabaseProvider>;
  authentication?: Partial<RuntimeAuthenticationProvider>;
  tenancy?: Partial<RuntimeTenancyProvider>;
  assets?: Partial<RuntimeAssetProvider>;
  secrets?: Partial<RuntimeSecretProvider>;
  jobs?: Partial<RuntimeJobProvider>;
  network?: Partial<RuntimeNetworkProvider>;
}

/** Canonical config stored at `runtime` in `smrt.config.ts`. */
export interface ApplicationRuntimeConfig {
  profile: ApplicationRuntimeProfile;
  providers?: RuntimeProviderOverrides;
}

/** Derived capabilities used by startup, doctor, tests, and agent inspection. */
export interface RuntimeCapabilities {
  readonly ownerBootstrap: boolean;
  readonly publicAuthentication: boolean;
  readonly defaultTenant: boolean;
  readonly multiTenant: boolean;
  readonly localAssets: boolean;
  readonly externalWorkers: boolean;
  readonly backup: true;
  readonly logicalExport: true;
  readonly logicalImport: true;
  readonly diagnostics: true;
  readonly orchestrationHealth: boolean;
}

/** Behaviors that provider/profile selection is never allowed to change. */
export interface RuntimeInvariants {
  readonly domainModels: 'identical';
  readonly generatedRest: 'identical';
  readonly generatedCli: 'identical';
  readonly generatedMcp: 'identical';
  readonly generatedWebMcp: 'identical';
  readonly mcpExposurePolicy: 'identical';
  readonly webMcpExposurePolicy: 'identical';
  readonly actionEffects: 'identical';
  readonly approvalPolicy: 'identical';
  readonly authorizationRecords: 'required';
  readonly jobInvocation: 'identical';
  readonly portability: 'logical-export-import';
}

export interface RuntimeOverrideReport {
  readonly path: string;
  readonly from: string | boolean;
  readonly to: string | boolean;
}

/** Deterministic, secret-free runtime diagnostic snapshot. */
export interface ResolvedApplicationRuntime {
  readonly schemaVersion: 1;
  readonly profile: ApplicationRuntimeProfile;
  readonly providers: RuntimeProviders;
  readonly capabilities: RuntimeCapabilities;
  readonly invariants: RuntimeInvariants;
  readonly diagnostics: {
    readonly secretValuesIncluded: false;
    readonly overrides: readonly RuntimeOverrideReport[];
    readonly unsafeOverrides: readonly [];
  };
}

export interface RuntimeProfileValidationIssue {
  code: 'invalid_config' | 'unsupported_field' | 'incompatible_provider';
  path: string;
  message: string;
  recovery: string;
}

/** Aggregates deterministic, actionable failures before application startup. */
export class RuntimeProfileValidationError extends Error {
  readonly issues: readonly RuntimeProfileValidationIssue[];

  constructor(issues: RuntimeProfileValidationIssue[]) {
    super(
      `Invalid application runtime profile:\n${issues
        .map(
          (issue) =>
            `- ${issue.path}: ${issue.message} Recovery: ${issue.recovery}`,
        )
        .join('\n')}`,
    );
    this.name = 'RuntimeProfileValidationError';
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
  }
}

const PROFILE_DEFAULTS: Record<ApplicationRuntimeProfile, RuntimeProviders> = {
  local: {
    database: { engine: 'sqlite', connectionOwnership: 'user' },
    authentication: {
      provider: 'owner-bootstrap',
      ownerBootstrap: 'single-use',
    },
    tenancy: {
      mode: 'default-tenant',
      context: 'defaulted',
      isolation: 'application',
    },
    assets: { provider: 'local-files', ownership: 'user' },
    secrets: { provider: 'local-file', ownership: 'user' },
    jobs: { topology: 'embedded' },
    network: { exposure: 'loopback', tls: false },
    portability: {
      backup: 'file-snapshot',
      logicalExport: true,
      logicalImport: true,
    },
  },
  'self-hosted': {
    database: { engine: 'postgres', connectionOwnership: 'operator' },
    authentication: { provider: 'oidc', ownerBootstrap: 'disabled' },
    tenancy: {
      mode: 'single-tenant',
      context: 'defaulted',
      isolation: 'application',
    },
    assets: { provider: 's3-compatible', ownership: 'operator' },
    secrets: { provider: 'environment', ownership: 'operator' },
    jobs: { topology: 'external' },
    network: { exposure: 'public', tls: true },
    portability: {
      backup: 'operator',
      logicalExport: true,
      logicalImport: true,
    },
  },
  cloud: {
    database: { engine: 'postgres', connectionOwnership: 'managed' },
    authentication: {
      provider: 'hosted-identity',
      ownerBootstrap: 'disabled',
    },
    tenancy: {
      mode: 'multi-tenant',
      context: 'required',
      isolation: 'database-rls',
    },
    assets: { provider: 'managed-object-storage', ownership: 'managed' },
    secrets: { provider: 'managed', ownership: 'managed' },
    jobs: { topology: 'scalable' },
    network: { exposure: 'public', tls: true },
    portability: {
      backup: 'managed',
      logicalExport: true,
      logicalImport: true,
    },
  },
};

const INVARIANTS: RuntimeInvariants = {
  domainModels: 'identical',
  generatedRest: 'identical',
  generatedCli: 'identical',
  generatedMcp: 'identical',
  generatedWebMcp: 'identical',
  mcpExposurePolicy: 'identical',
  webMcpExposurePolicy: 'identical',
  actionEffects: 'identical',
  approvalPolicy: 'identical',
  authorizationRecords: 'required',
  jobInvocation: 'identical',
  portability: 'logical-export-import',
};

const PROVIDER_FIELDS = {
  database: ['engine', 'connectionOwnership'],
  authentication: ['provider', 'ownerBootstrap'],
  tenancy: ['mode', 'context', 'isolation'],
  assets: ['provider', 'ownership'],
  secrets: ['provider', 'ownership'],
  jobs: ['topology'],
  network: ['exposure', 'tls'],
} as const;

type OverridableProvider = keyof typeof PROVIDER_FIELDS;

const PROVIDER_VALUE_DOMAINS = {
  database: {
    engine: ['sqlite', 'postgres'],
    connectionOwnership: ['user', 'operator', 'managed'],
  },
  authentication: {
    provider: ['owner-bootstrap', 'oidc', 'magic-link', 'hosted-identity'],
    ownerBootstrap: ['single-use', 'disabled'],
  },
  tenancy: {
    mode: ['default-tenant', 'single-tenant', 'multi-tenant'],
    context: ['defaulted', 'required'],
    isolation: ['application', 'database-rls'],
  },
  assets: {
    provider: ['local-files', 's3-compatible', 'managed-object-storage'],
    ownership: ['user', 'operator', 'managed'],
  },
  secrets: {
    provider: ['local-file', 'environment', 'external', 'managed'],
    ownership: ['user', 'operator', 'managed'],
  },
  jobs: { topology: ['inline', 'embedded', 'external', 'scalable'] },
  network: { exposure: ['loopback', 'public'], tls: [false, true] },
} as const satisfies {
  [Provider in OverridableProvider]: Record<
    (typeof PROVIDER_FIELDS)[Provider][number],
    readonly unknown[]
  >;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneDefaults(profile: ApplicationRuntimeProfile): RuntimeProviders {
  const defaults = PROFILE_DEFAULTS[profile];
  return {
    database: { ...defaults.database },
    authentication: { ...defaults.authentication },
    tenancy: { ...defaults.tenancy },
    assets: { ...defaults.assets },
    secrets: { ...defaults.secrets },
    jobs: { ...defaults.jobs },
    network: { ...defaults.network },
    portability: { ...defaults.portability },
  };
}

function rejectUnknownFields(
  input: Record<string, unknown>,
): RuntimeProfileValidationIssue[] {
  const issues: RuntimeProfileValidationIssue[] = [];
  for (const key of Object.keys(input).sort()) {
    if (key !== 'profile' && key !== 'providers') {
      issues.push({
        code: 'unsupported_field',
        path: key,
        message: 'is not part of the runtime-profile contract.',
        recovery:
          'Move provider selection under providers or remove this field.',
      });
    }
  }

  const providers = Object.hasOwn(input, 'providers')
    ? input.providers
    : undefined;
  if (providers === undefined) return issues;
  if (!isPlainRecord(providers)) {
    issues.push({
      code: 'invalid_config',
      path: 'providers',
      message: 'must be an object with Object.prototype or null.',
      recovery: 'Use providers: { database: { ... } } or omit providers.',
    });
    return issues;
  }

  for (const providerName of Object.keys(providers).sort()) {
    if (!Object.hasOwn(PROVIDER_FIELDS, providerName)) {
      issues.push({
        code: 'unsupported_field',
        path: `providers.${providerName}`,
        message: 'is not an overridable infrastructure provider.',
        recovery:
          'Use database, authentication, tenancy, assets, secrets, jobs, or network.',
      });
      continue;
    }
    const value = providers[providerName];
    if (!isPlainRecord(value)) {
      issues.push({
        code: 'invalid_config',
        path: `providers.${providerName}`,
        message: 'must be an object with Object.prototype or null.',
        recovery: `Provide a partial ${providerName} provider object or omit it.`,
      });
      continue;
    }
    const allowed = PROVIDER_FIELDS[
      providerName as OverridableProvider
    ] as readonly string[];
    const valueDomains = PROVIDER_VALUE_DOMAINS[
      providerName as OverridableProvider
    ] as Record<string, readonly unknown[]>;
    for (const field of Object.keys(value).sort()) {
      if (!allowed.includes(field)) {
        issues.push({
          code: 'unsupported_field',
          path: `providers.${providerName}.${field}`,
          message: 'is not a supported provider override.',
          recovery:
            'Remove secret values and application-policy fields; configure only documented provider selectors.',
        });
        continue;
      }
      const suppliedValue = Object.hasOwn(value, field)
        ? value[field]
        : undefined;
      const allowedValues = valueDomains[field];
      if (
        suppliedValue !== undefined &&
        !allowedValues.includes(suppliedValue)
      ) {
        issues.push({
          code: 'invalid_config',
          path: `providers.${providerName}.${field}`,
          message: `must be one of ${allowedValues.map(String).join(', ')}.`,
          recovery:
            'Choose a documented provider selector value; supplied values are omitted from diagnostics.',
        });
      }
    }
  }
  return issues;
}

/**
 * Validate only the runtime contract's object and field shape.
 *
 * @internal Used while composing configuration layers before a profile is
 * necessarily available. Full profile/provider compatibility validation stays
 * in {@link resolveApplicationRuntime}.
 */
export function validateApplicationRuntimeConfigShape(
  config: unknown,
): readonly RuntimeProfileValidationIssue[] {
  if (!isPlainRecord(config)) {
    return [
      {
        code: 'invalid_config',
        path: 'runtime',
        message: 'must be an object with Object.prototype or null.',
        recovery:
          'Provide runtime: { profile: "local" | "self-hosted" | "cloud" }.',
      },
    ];
  }
  return rejectUnknownFields(config);
}

function applyOverrides(
  providers: RuntimeProviders,
  input: Record<string, unknown>,
): RuntimeOverrideReport[] {
  const overrideRoot =
    Object.hasOwn(input, 'providers') && isPlainRecord(input.providers)
      ? input.providers
      : {};
  const report: RuntimeOverrideReport[] = [];

  for (const providerName of Object.keys(
    PROVIDER_FIELDS,
  ) as OverridableProvider[]) {
    if (!Object.hasOwn(overrideRoot, providerName)) continue;
    const supplied = overrideRoot[providerName];
    if (!isPlainRecord(supplied)) continue;
    const target = providers[providerName] as unknown as Record<
      string,
      unknown
    >;
    for (const field of PROVIDER_FIELDS[providerName]) {
      if (!Object.hasOwn(supplied, field)) continue;
      const value = supplied[field];
      if (value === undefined) continue;
      const previous = target[field];
      target[field] = value;
      if (value !== previous) {
        report.push({
          path: `providers.${providerName}.${field}`,
          from: previous as string | boolean,
          to: value as string | boolean,
        });
      }
    }
  }
  return report;
}

function incompatible(
  issues: RuntimeProfileValidationIssue[],
  path: string,
  expected: string,
  recovery: string,
): void {
  issues.push({
    code: 'incompatible_provider',
    path,
    message: `is incompatible; ${expected}.`,
    recovery,
  });
}

function requireAllowed(
  issues: RuntimeProfileValidationIssue[],
  path: string,
  actual: unknown,
  allowed: readonly unknown[],
  profile: ApplicationRuntimeProfile,
): void {
  if (!allowed.includes(actual)) {
    incompatible(
      issues,
      path,
      `${profile} requires one of ${allowed.map(String).join(', ')}`,
      `Choose a supported ${profile} provider or select a different profile.`,
    );
  }
}

function validateComposition(
  profile: ApplicationRuntimeProfile,
  providers: RuntimeProviders,
): RuntimeProfileValidationIssue[] {
  const issues: RuntimeProfileValidationIssue[] = [];
  const allow = (path: string, actual: unknown, values: readonly unknown[]) =>
    requireAllowed(issues, path, actual, values, profile);

  if (profile === 'local') {
    allow('providers.database.engine', providers.database.engine, ['sqlite']);
    allow(
      'providers.database.connectionOwnership',
      providers.database.connectionOwnership,
      ['user'],
    );
    allow(
      'providers.authentication.provider',
      providers.authentication.provider,
      ['owner-bootstrap'],
    );
    allow(
      'providers.authentication.ownerBootstrap',
      providers.authentication.ownerBootstrap,
      ['single-use'],
    );
    allow('providers.tenancy.mode', providers.tenancy.mode, ['default-tenant']);
    allow('providers.tenancy.context', providers.tenancy.context, [
      'defaulted',
    ]);
    allow('providers.tenancy.isolation', providers.tenancy.isolation, [
      'application',
    ]);
    allow('providers.assets.provider', providers.assets.provider, [
      'local-files',
    ]);
    allow('providers.assets.ownership', providers.assets.ownership, ['user']);
    allow('providers.secrets.provider', providers.secrets.provider, [
      'local-file',
    ]);
    allow('providers.secrets.ownership', providers.secrets.ownership, ['user']);
    allow('providers.jobs.topology', providers.jobs.topology, [
      'inline',
      'embedded',
    ]);
    allow('providers.network.exposure', providers.network.exposure, [
      'loopback',
    ]);
    allow('providers.network.tls', providers.network.tls, [false, true]);
  } else if (profile === 'self-hosted') {
    allow('providers.database.engine', providers.database.engine, ['postgres']);
    allow(
      'providers.database.connectionOwnership',
      providers.database.connectionOwnership,
      ['operator'],
    );
    allow(
      'providers.authentication.provider',
      providers.authentication.provider,
      ['oidc', 'magic-link'],
    );
    allow(
      'providers.authentication.ownerBootstrap',
      providers.authentication.ownerBootstrap,
      ['disabled'],
    );
    allow('providers.tenancy.mode', providers.tenancy.mode, [
      'single-tenant',
      'multi-tenant',
    ]);
    allow(
      'providers.tenancy.context',
      providers.tenancy.context,
      providers.tenancy.mode === 'multi-tenant' ? ['required'] : ['defaulted'],
    );
    allow('providers.tenancy.isolation', providers.tenancy.isolation, [
      'application',
      'database-rls',
    ]);
    allow('providers.assets.provider', providers.assets.provider, [
      'local-files',
      's3-compatible',
    ]);
    allow('providers.assets.ownership', providers.assets.ownership, [
      'operator',
    ]);
    allow('providers.secrets.provider', providers.secrets.provider, [
      'environment',
      'local-file',
      'external',
    ]);
    allow('providers.secrets.ownership', providers.secrets.ownership, [
      'operator',
    ]);
    allow('providers.jobs.topology', providers.jobs.topology, ['external']);
    allow('providers.network.exposure', providers.network.exposure, ['public']);
    allow('providers.network.tls', providers.network.tls, [true]);
  } else {
    allow('providers.database.engine', providers.database.engine, ['postgres']);
    allow(
      'providers.database.connectionOwnership',
      providers.database.connectionOwnership,
      ['managed'],
    );
    allow(
      'providers.authentication.provider',
      providers.authentication.provider,
      ['hosted-identity'],
    );
    allow(
      'providers.authentication.ownerBootstrap',
      providers.authentication.ownerBootstrap,
      ['disabled'],
    );
    allow('providers.tenancy.mode', providers.tenancy.mode, ['multi-tenant']);
    allow('providers.tenancy.context', providers.tenancy.context, ['required']);
    allow('providers.tenancy.isolation', providers.tenancy.isolation, [
      'application',
      'database-rls',
    ]);
    allow('providers.assets.provider', providers.assets.provider, [
      'managed-object-storage',
      's3-compatible',
    ]);
    allow('providers.assets.ownership', providers.assets.ownership, [
      'managed',
    ]);
    allow('providers.secrets.provider', providers.secrets.provider, [
      'managed',
      'external',
    ]);
    allow('providers.secrets.ownership', providers.secrets.ownership, [
      'managed',
    ]);
    allow('providers.jobs.topology', providers.jobs.topology, ['scalable']);
    allow('providers.network.exposure', providers.network.exposure, ['public']);
    allow('providers.network.tls', providers.network.tls, [true]);
  }

  return issues;
}

function deriveCapabilities(
  profile: ApplicationRuntimeProfile,
  providers: RuntimeProviders,
): RuntimeCapabilities {
  return {
    ownerBootstrap: providers.authentication.ownerBootstrap === 'single-use',
    publicAuthentication:
      providers.authentication.provider !== 'owner-bootstrap',
    defaultTenant: providers.tenancy.context === 'defaulted',
    multiTenant: providers.tenancy.mode === 'multi-tenant',
    localAssets: providers.assets.provider === 'local-files',
    externalWorkers:
      providers.jobs.topology === 'external' ||
      providers.jobs.topology === 'scalable',
    backup: true,
    logicalExport: true,
    logicalImport: true,
    diagnostics: true,
    orchestrationHealth: profile !== 'local',
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Resolve a safe preset and explicit provider overrides into a stable snapshot.
 *
 * The resolver is pure: it reads no environment variables, paths, credentials,
 * clocks, or process state. Invalid and unknown fields fail before startup.
 */
export function resolveApplicationRuntime(
  config: ApplicationRuntimeConfig,
): Readonly<ResolvedApplicationRuntime> {
  if (!isPlainRecord(config)) {
    throw new RuntimeProfileValidationError([
      ...validateApplicationRuntimeConfigShape(config),
    ]);
  }

  const unknownIssues = validateApplicationRuntimeConfigShape(config);
  const profile = Object.hasOwn(config, 'profile') ? config.profile : undefined;
  if (profile !== 'local' && profile !== 'self-hosted' && profile !== 'cloud') {
    throw new RuntimeProfileValidationError([
      ...unknownIssues,
      {
        code: 'invalid_config',
        path: 'profile',
        message: 'must be local, self-hosted, or cloud.',
        recovery: 'Select one documented runtime profile.',
      },
    ]);
  }

  const providers = cloneDefaults(profile);
  const overrides = applyOverrides(providers, config);
  const issues = [...unknownIssues, ...validateComposition(profile, providers)];
  if (issues.length > 0) throw new RuntimeProfileValidationError(issues);

  return deepFreeze({
    schemaVersion: 1,
    profile,
    providers,
    capabilities: deriveCapabilities(profile, providers),
    invariants: { ...INVARIANTS },
    diagnostics: {
      secretValuesIncluded: false,
      overrides,
      unsafeOverrides: [],
    },
  }) as Readonly<ResolvedApplicationRuntime>;
}

/** Return a fresh copy of the documented preset for inspection and tooling. */
export function getApplicationRuntimePreset(
  profile: ApplicationRuntimeProfile,
): Readonly<RuntimeProviders> {
  if (profile !== 'local' && profile !== 'self-hosted' && profile !== 'cloud') {
    throw new RuntimeProfileValidationError([
      {
        code: 'invalid_config',
        path: 'profile',
        message: 'must be local, self-hosted, or cloud.',
        recovery: 'Select one documented runtime profile.',
      },
    ]);
  }
  return deepFreeze(cloneDefaults(profile));
}
