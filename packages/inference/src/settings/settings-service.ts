/**
 * Server half of the inference settings screen (#4754), mirroring
 * smrt-prompts' `PromptSettingsService`: row shapes for the panel, revert
 * previews computed explicitly per scope, and writes delegated to the
 * authorizer-gated {@link InferenceOverrideService} (read-only without an
 * authorizer). Test connection and the doctor reuse `./node` (#4752).
 *
 * Makes no authorization decision of its own: call it only from server code
 * that has already established who the caller is.
 */
import { AI_PROVIDER_TYPES } from '@happyvertical/ai';
import { getDefaultAIKeyEnvName } from '@happyvertical/smrt-config';
import {
  type AiUsageReport,
  type AiUsageReportDimension,
  config as coreConfig,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  DEFAULT_TRANSCRIPT_SAMPLE,
  getInferenceConfig,
  getInferenceTranscriptsConfig,
  INFERENCE_PRESET_IDS,
  INFERENCE_PRESETS,
  INFERENCE_TIERS,
  type InferenceAlias,
  type InferenceCandidate,
  type InferenceConfig,
  type InferenceFusionDefinition,
  type InferenceTarget,
  type InferenceTier,
  type InferenceTranscriptsConfig,
  type RetentionPolicy,
  reportAiUsage,
  resolveAutoTier,
  type SmrtClassOptions,
  type SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
import {
  findFusionDefinitionIssues,
  findFusionDefinitionPromptIssues,
  findInferenceConfigIssues,
} from '../config.js';
import { getFusion, listFusions } from '../fusion.js';
import { APP_INFERENCE_SCOPE_ID } from '../models/InferenceOverride.js';
import {
  InferenceOverrideCollection,
  type InferenceOverrideScopeType,
} from '../models/InferenceOverrideCollection.js';
import {
  checkInferenceBindings,
  type InferenceDoctorReport,
  inferenceProbeUrl,
  probeInferenceCandidate,
} from '../node.js';
import type { InferenceConfigIssue } from '../types.js';
import {
  type InferenceKeyRecord,
  inferenceKeyFor,
  redactInferenceSecret,
} from './keys.js';
import {
  type InferenceOverrideLayers,
  type InferenceSettingsConfig,
  isUnreadableFusionRow,
  loadInferenceOverrideLayers,
  mergeSettingsConfigs,
  unreadableFusionIssue,
} from './layers.js';
import {
  type InferenceOverrideAuthorizer,
  InferenceOverrideService,
  type InferenceTenantTargetPolicy,
} from './override-service.js';
import {
  DEFAULT_TIER_BINDING,
  describeInferenceTarget,
  INFERENCE_BINDING_NAME_PATTERN,
  InferenceBindingValueError,
  type InferenceTranscriptSettingsValue,
  normalizeFusionDefinition,
  stripKeyMembers,
  TRANSCRIPTS_BINDING,
  tierBinding,
} from './targets.js';
import {
  applyStoredTranscriptSettings,
  storedTranscriptSettings,
} from './transcripts.js';

/** Which level supplied an effective value. */
export type InferenceSettingsLevel = 'default' | 'config' | 'app' | 'tenant';

/** One tier, rendered for a settings screen. */
export interface InferenceTierSettingsRow {
  binding: `tier:${InferenceTier}`;
  tier: InferenceTier;
  /** What the tier resolves to for the requested tenant; `null` is the configured client. */
  effectiveTarget: InferenceTarget | null;
  effectiveLabel: string;
  supplyingLevel: InferenceSettingsLevel;
  /** The `inference` config's binding (code default + config files + env). */
  configTarget: InferenceTarget | null;
  /** The app row's raw value, `null` when none. */
  appTarget: InferenceTarget | null;
  /**
   * The tenant row's raw value, `null` when none or no tenant was requested.
   * Present even when {@link tenantBlocked}: the screen shows why it is not
   * in effect.
   */
  tenantTarget: InferenceTarget | null;
  /** What reverting the **app** scope produces: the config binding. */
  appRevertTarget: InferenceTarget | null;
  appRevertLabel: string;
  /**
   * What reverting the **tenant** scope produces: config plus the app row.
   * `null` label when no tenant was requested (nothing computed it).
   */
  inheritedTarget: InferenceTarget | null;
  inheritedLabel: string | null;
  /** The tenant allow-list on the app row (`null`: tenants may bind nothing). */
  tenantAllowList: string[] | null;
  /** A tenant row exists but the allow-list or policy refuses it now. */
  tenantBlocked: boolean;
}

/** `auto`'s default tier, rendered for a settings screen. */
export interface InferenceDefaultTierSetting {
  binding: typeof DEFAULT_TIER_BINDING;
  effectiveTier: InferenceTier;
  supplyingLevel: InferenceSettingsLevel;
  configTier: InferenceTier | null;
  appTier: InferenceTier | null;
  tenantTier: InferenceTier | null;
  /** What reverting the app scope produces (config, else `good`). */
  appRevertTier: InferenceTier;
  /** What reverting the tenant scope produces; `null` when no tenant was requested. */
  inheritedTier: InferenceTier | null;
  tenantAllowList: string[] | null;
  tenantBlocked: boolean;
}

/** One alias for the alias editor. */
export interface InferenceAliasSetting {
  name: string;
  /** Where the effective definition comes from (an app row replaces config whole). */
  source: 'config' | 'app';
  candidates: InferenceCandidate[];
  description?: string;
  /** True when config also defines it (reverting the app row restores that). */
  inConfig: boolean;
}

/** One fusion for the fusion list (#4753 owns their meaning). */
export interface InferenceFusionSetting {
  name: string;
  source: 'registry' | 'config' | 'app';
  /** The definition as JSON-safe data. */
  definition: Record<string, unknown>;
  description?: string;
  /** Config entries (app rows) can be edited as JSON; registry fusions are code. */
  editable: boolean;
  /**
   * Lower sources this definition replaces by name (#4800): an app row
   * shadows config and the registry, config shadows the registry, exactly
   * as the executor picks. Absent when nothing is shadowed.
   */
  shadows?: Array<'registry' | 'config'>;
  /**
   * Why the executor would refuse to run this definition (structure,
   * aliases, unregistered seat prompt keys), checked as the executor
   * checks it (#4800). Absent when it would run.
   */
  issues?: InferenceConfigIssue[];
}

/**
 * The app's transcript setting (#4781), for the panel's Advanced section.
 * App level only: tenants cannot override it, so it is the same for every
 * tenant. Never carries transcript content.
 */
export interface InferenceTranscriptSettings {
  binding: typeof TRANSCRIPTS_BINDING;
  /** Effective values: config < app row < `SMRT_INFERENCE_TRANSCRIPTS`. */
  enabled: boolean;
  sample: number;
  maxBytes: number;
  /** Which level supplied `enabled`. */
  supplyingLevel: 'default' | 'config' | 'app' | 'env';
  /** The app row's stored value (`null`: none). */
  appValue: InferenceTranscriptSettingsValue | null;
  /** What reverting the app row produces (config and env only). */
  appRevert: { enabled: boolean; sample: number; maxBytes: number };
  /** `SMRT_INFERENCE_TRANSCRIPTS` forces `enabled` to this (`null`: unset). */
  envEnabled: boolean | null;
  /**
   * Days transcripts are kept by the retention sweep
   * (`retention.aiTranscripts.maxAgeDays`); `null` when the sweep skips
   * them. Read-only here: the sweep runs with its caller's policy.
   */
  retentionDays: number | null;
  /** Prompt keys with their own sample rate in config (read-only). */
  promptOverrides: string[];
}

/** One provider choice for the default view. */
export interface InferenceProviderOption {
  id: string;
  label: string;
  /** `preset` (#4674 endpoint presets) or `provider` (the AI SDK list). */
  kind: 'preset' | 'provider';
  baseUrl?: string;
  requiresApiKey: boolean;
  /** Needs a base URL before a key can be bound (gateways). */
  needsBaseUrl?: boolean;
  /** A loopback server (local discovery applies). */
  local?: boolean;
}

/** What Test connection probes. Never carries a key: the host supplies the stored record. */
export interface InferenceConnectionInput {
  provider?: string;
  preset?: string;
  baseUrl?: string;
  model?: string;
}

/** Key-free result of a test. */
export interface InferenceConnectionResult {
  reachable: boolean;
  skipped?: boolean;
  status?: number;
  durationMs: number;
  detail: string;
  /** Whether a stored key was sent (only ever to its bound origin). */
  keySent: boolean;
}

/** A fusion the host's registry knows (soft dependency on #4753's `defineFusion`). */
export interface RegisteredFusionLike {
  key: string;
  description?: string;
  [member: string]: unknown;
}

/** Options for {@link InferenceSettingsService.create}. */
export interface InferenceSettingsServiceOptions {
  /** Host authorizer. Omit for a read-only (load-function) service: writes fail closed. */
  authorize?: InferenceOverrideAuthorizer;
  /** The code half of the tenant allow-list (#4667 caps hosted tiers here). */
  tenantTargetPolicy?: InferenceTenantTargetPolicy;
  /** The config layer. Default core's merged `getInferenceConfig()`. */
  config?: () => InferenceConfig | undefined;
  /**
   * Registered fusions. Default: #4753's process registry (`defineFusion()`).
   */
  registryFusions?: () => Iterable<RegisteredFusionLike>;
  /**
   * The transcript config with an app layer (#4781). Default core's
   * `getInferenceTranscriptsConfig()` (config < app < env).
   */
  transcriptsConfig?: (
    app: InferenceTranscriptsConfig | null,
  ) => InferenceTranscriptsConfig | undefined;
  /** The retention policy the sweep runs with. Default core `config().retention`. */
  retention?: () => RetentionPolicy | undefined;
}

/** #4753's process registry as {@link RegisteredFusionLike} entries. */
function defaultRegistryFusions(): RegisteredFusionLike[] {
  return listFusions().flatMap((key) => {
    const definition = getFusion(key);
    return definition ? [{ ...definition, key }] : [];
  });
}

/** Thrown when a write would leave the layered config invalid. Nothing is written. */
export class InferenceSettingsConfigError extends Error {
  readonly status = 400;
  constructor(readonly issues: InferenceConfigIssue[]) {
    super(
      `Inference binding refused: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'InferenceSettingsConfigError';
  }
}

/** Thrown when removing an alias or fusion that something still names. Nothing is written. */
export class InferenceBindingInUseError extends Error {
  readonly status = 409;
  constructor(
    readonly binding: string,
    /** App-scope and config referrers. */
    readonly referrers: string[],
    /** How many tenant rows name it (never which tenants). */
    readonly tenantReferences: number,
  ) {
    const parts = [...referrers];
    if (tenantReferences > 0) {
      parts.push(`${tenantReferences} tenant binding(s)`);
    }
    super(`${binding} is still referenced by ${parts.join(', ')}`);
    this.name = 'InferenceBindingInUseError';
  }
}

/** See prompts' `withoutListBounds`: an enumeration read must never be capped. */
function withoutListBounds(
  options: SmrtClassOptions | SmrtCollectionOptions,
): SmrtCollectionOptions {
  return { ...options, defaultListLimit: undefined, maxListLimit: undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rawValue(
  layers: InferenceOverrideLayers,
  scope: 'app' | 'tenant',
  binding: string,
): unknown {
  const row = (scope === 'app' ? layers.appRows : layers.tenantRows).get(
    binding,
  );
  if (!row) return null;
  try {
    return row.getValue();
  } catch {
    return null;
  }
}

function allowListOf(
  layers: InferenceOverrideLayers,
  binding: string,
): string[] | null {
  try {
    return layers.appRows.get(binding)?.getTenantAllowList() ?? null;
  } catch {
    return null;
  }
}

/** A config target for a screen: `null` when empty, never with a credential. */
function nonEmpty(target: InferenceTarget | undefined | null) {
  return target && Object.keys(target).length > 0
    ? stripKeyMembers(target)
    : null;
}

function bindingRefersTo(
  binding: string,
  value: unknown,
  kind: 'alias' | 'fusion',
  name: string,
): boolean {
  if (!isRecord(value)) return false;
  if (binding.startsWith('tier:')) {
    return kind === 'alias'
      ? value.alias === name
      : value.fusion === name ||
          (value.kind === 'fusion' && value.fusion === name);
  }
  if (
    kind === 'alias' &&
    binding.startsWith('alias:') &&
    binding !== `alias:${name}`
  ) {
    return (
      Array.isArray(value.candidates) &&
      value.candidates.some(
        (candidate) => isRecord(candidate) && candidate.alias === name,
      )
    );
  }
  return false;
}

/** Usage tab dimensions (`usage()`). */
export type InferenceUsageReportDimension = Extract<
  AiUsageReportDimension,
  'model' | 'tier' | 'prompt' | 'fusion' | 'template'
>;

/** Days the retention sweep keeps transcripts under `policy`, or `null`. */
function transcriptRetentionDays(
  policy: RetentionPolicy | undefined,
): number | null {
  if (policy?.enabled === false || policy?.aiTranscripts === false) {
    return null;
  }
  return (
    policy?.aiTranscripts?.maxAgeDays ??
    DEFAULT_RETENTION_POLICY.aiTranscripts.maxAgeDays ??
    null
  );
}

const PRESET_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  lemonade: 'Lemonade (local)',
  'llama.cpp': 'llama.cpp (local)',
  'lm-studio': 'LM Studio (local)',
};

/**
 * Read and write side of an inference settings screen. See the module doc.
 */
export class InferenceSettingsService {
  private readonly writes: InferenceOverrideService;
  private readonly readConfig: () => InferenceConfig | undefined;

  constructor(
    private readonly overrides: InferenceOverrideCollection,
    private readonly options: InferenceSettingsServiceOptions = {},
  ) {
    this.writes = new InferenceOverrideService(
      overrides,
      options.authorize ?? (() => false),
      { tenantTargetPolicy: options.tenantTargetPolicy },
    );
    this.readConfig = options.config ?? getInferenceConfig;
  }

  /** Build a service over the given database options (list bounds stripped). */
  static async create(
    options: SmrtClassOptions = {},
    serviceOptions: InferenceSettingsServiceOptions = {},
  ): Promise<InferenceSettingsService> {
    const overrides = await InferenceOverrideCollection.create(
      withoutListBounds(options),
    );
    return new InferenceSettingsService(
      overrides as InferenceOverrideCollection,
      serviceOptions,
    );
  }

  private loadLayers(tenantId: string | null | undefined) {
    return loadInferenceOverrideLayers(this.overrides, {
      tenantId,
      tenantTargetPolicy: this.options.tenantTargetPolicy,
    });
  }

  /**
   * The effective config for a tenant: config < app rows < allowed tenant
   * rows. What the override resolver binds and the doctor checks.
   * Server-side only: config layers may carry literal keys, so never send
   * this to a browser (the row methods strip them).
   */
  async getEffectiveConfig(
    options: { tenantId?: string | null } = {},
  ): Promise<InferenceSettingsConfig | undefined> {
    const layers = await this.loadLayers(options.tenantId);
    return mergeSettingsConfigs(this.readConfig(), layers.app, layers.tenant);
  }

  /**
   * One row per tier (`cheap`, `good`, `great`, `best`): the effective
   * target, each scope's raw override, and both revert previews.
   */
  async listInferenceSettings(
    options: { tenantId?: string | null } = {},
  ): Promise<InferenceTierSettingsRow[]> {
    const tenantId = options.tenantId ?? null;
    const layers = await this.loadLayers(tenantId);
    const config = this.readConfig();
    return INFERENCE_TIERS.map((tier) => {
      const binding = tierBinding(tier);
      const configTarget = nonEmpty(config?.tiers?.[tier]);
      const appTarget = rawValue(
        layers,
        'app',
        binding,
      ) as InferenceTarget | null;
      const tenantTarget = tenantId
        ? (rawValue(layers, 'tenant', binding) as InferenceTarget | null)
        : null;
      const tenantBlocked = layers.blockedTenantBindings.includes(binding);
      const tenantEffective = tenantBlocked ? null : tenantTarget;
      // Computed separately per scope (the prompts invariant): the app
      // revert never includes the app row; the tenant revert always does.
      const appRevertTarget = configTarget;
      const inheritedTarget = appTarget ?? configTarget;
      const effectiveTarget = tenantEffective ?? appTarget ?? configTarget;
      const supplyingLevel: InferenceSettingsLevel = tenantEffective
        ? 'tenant'
        : appTarget
          ? 'app'
          : configTarget
            ? 'config'
            : 'default';
      return {
        binding,
        tier,
        effectiveTarget,
        effectiveLabel: describeInferenceTarget(effectiveTarget),
        supplyingLevel,
        configTarget,
        appTarget,
        tenantTarget,
        appRevertTarget,
        appRevertLabel: describeInferenceTarget(appRevertTarget),
        inheritedTarget: tenantId ? inheritedTarget : null,
        inheritedLabel: tenantId
          ? describeInferenceTarget(inheritedTarget)
          : null,
        tenantAllowList: allowListOf(layers, binding),
        tenantBlocked,
      };
    });
  }

  /** `auto`'s default tier with the same per-scope shape. */
  async getDefaultTierSetting(
    options: { tenantId?: string | null } = {},
  ): Promise<InferenceDefaultTierSetting> {
    const tenantId = options.tenantId ?? null;
    const layers = await this.loadLayers(tenantId);
    const config = this.readConfig();
    const configTier = config?.defaultTier ?? null;
    const appTier = rawValue(
      layers,
      'app',
      DEFAULT_TIER_BINDING,
    ) as InferenceTier | null;
    const tenantTier = tenantId
      ? (rawValue(
          layers,
          'tenant',
          DEFAULT_TIER_BINDING,
        ) as InferenceTier | null)
      : null;
    const tenantBlocked =
      layers.blockedTenantBindings.includes(DEFAULT_TIER_BINDING);
    const tenantEffective = tenantBlocked ? null : tenantTier;
    const appRevertTier = resolveAutoTier(config);
    const inheritedTier = appTier ?? appRevertTier;
    return {
      binding: DEFAULT_TIER_BINDING,
      effectiveTier: tenantEffective ?? inheritedTier,
      supplyingLevel: tenantEffective
        ? 'tenant'
        : appTier
          ? 'app'
          : configTier
            ? 'config'
            : 'default',
      configTier,
      appTier,
      tenantTier,
      appRevertTier,
      inheritedTier: tenantId ? inheritedTier : null,
      tenantAllowList: allowListOf(layers, DEFAULT_TIER_BINDING),
      tenantBlocked,
    };
  }

  /** Every alias: config entries, replaced whole by app rows. Sorted by name. */
  async listInferenceAliases(): Promise<InferenceAliasSetting[]> {
    const layers = await this.loadLayers(null);
    const configAliases = (this.readConfig()?.aliases ?? {}) as Record<
      string,
      InferenceAlias
    >;
    const names = new Set([
      ...Object.keys(configAliases),
      ...Object.keys(layers.app.aliases ?? {}),
    ]);
    return [...names].sort().map((name) => {
      const app = layers.app.aliases?.[name];
      const alias = app ?? configAliases[name];
      const setting: InferenceAliasSetting = {
        name,
        source: app ? 'app' : 'config',
        candidates: Array.isArray(alias?.candidates)
          ? stripKeyMembers(alias.candidates)
          : [],
        inConfig: Object.hasOwn(configAliases, name),
      };
      if (alias?.description) setting.description = alias.description;
      return setting;
    });
  }

  /**
   * Fusions from the host's registry (code, read-only), the config's
   * `inference.fusions`, and app rows (editable JSON). A later source
   * shadows an earlier one by name, the executor's precedence (#4800): app
   * row, then config, then registry. Each entry carries the issues that
   * would make the executor refuse it, so the list shows what would run.
   */
  async listInferenceFusions(): Promise<InferenceFusionSetting[]> {
    const layers = await this.loadLayers(null);
    const config = this.readConfig() as InferenceSettingsConfig | undefined;
    const merged = mergeSettingsConfigs(config, layers.app);
    const out = new Map<string, InferenceFusionSetting>();
    const put = (
      setting: InferenceFusionSetting,
      raw: unknown,
      path: string,
      against: InferenceConfig | undefined,
    ) => {
      const previous = out.get(setting.name);
      const shadows = previous
        ? [
            ...(previous.shadows ?? []),
            previous.source as 'registry' | 'config',
          ]
        : [];
      const issues = [
        ...findFusionDefinitionIssues(raw, path, against),
        ...findFusionDefinitionPromptIssues(raw, path),
      ];
      if (shadows.length > 0) setting.shadows = shadows;
      if (issues.length > 0) setting.issues = issues;
      out.set(setting.name, setting);
    };
    const registry = this.options.registryFusions ?? defaultRegistryFusions;
    for (const fusion of registry()) {
      if (!fusion || typeof fusion.key !== 'string') continue;
      const definition = stripKeyMembers(
        JSON.parse(JSON.stringify(fusion)) as Record<string, unknown>,
      );
      const { key: _key, ...raw } = fusion;
      put(
        {
          name: fusion.key,
          source: 'registry',
          definition,
          description:
            typeof fusion.description === 'string'
              ? fusion.description
              : undefined,
          editable: false,
        },
        raw,
        `fusions.${fusion.key}`,
        config,
      );
    }
    if (isRecord(config?.fusions)) {
      for (const [name, definition] of Object.entries(config.fusions)) {
        if (!isRecord(definition)) continue;
        put(
          {
            name,
            source: 'config',
            definition: stripKeyMembers(definition),
            description:
              typeof definition.description === 'string'
                ? definition.description
                : undefined,
            editable: false,
          },
          definition,
          `inference.fusions.${name}`,
          config,
        );
      }
    }
    for (const [name, definition] of Object.entries(layers.app.fusions ?? {})) {
      put(
        {
          name,
          source: 'app',
          definition: definition as unknown as Record<string, unknown>,
          description:
            typeof definition.description === 'string'
              ? definition.description
              : undefined,
          editable: true,
        },
        definition,
        `fusion:${name}`,
        merged,
      );
    }
    // An app row that cannot be read wins the name and is refused by the
    // executor (#4800); its stored value is never echoed.
    for (const [binding, row] of layers.appRows) {
      if (!binding.startsWith('fusion:') || !isUnreadableFusionRow(row)) {
        continue;
      }
      const name = binding.slice('fusion:'.length);
      put(
        { name, source: 'app', definition: {}, editable: true },
        undefined,
        binding,
        merged,
      );
      const entry = out.get(name);
      if (entry) entry.issues = [unreadableFusionIssue(name)];
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Bind (or, with `null`, revert) one tier at one scope. Tenant writes must
   * pass the allow-list; every write goes through the authorizer.
   */
  async setTierOverride(request: {
    tier: InferenceTier;
    scopeType: InferenceOverrideScopeType;
    scopeId: string;
    target: InferenceTarget | null;
  }): Promise<void> {
    if (!INFERENCE_TIERS.includes(request.tier)) {
      throw new InferenceBindingValueError(
        `tier:${String(request.tier)}`,
        'unknown tier',
      );
    }
    const binding = tierBinding(request.tier);
    if (request.target !== null) {
      await this.assertConfigStaysValid(request.scopeType, request.scopeId, {
        tiers: { [request.tier]: request.target },
      });
    }
    await this.writes.setValue(
      binding,
      request.scopeType,
      request.scopeId,
      request.target,
    );
  }

  /** Set (or revert) `auto`'s default tier at one scope. */
  async setDefaultTierOverride(request: {
    scopeType: InferenceOverrideScopeType;
    scopeId: string;
    tier: InferenceTier | null;
  }): Promise<void> {
    await this.writes.setValue(
      DEFAULT_TIER_BINDING,
      request.scopeType,
      request.scopeId,
      request.tier === null ? null : { tier: request.tier },
    );
  }

  /** Set (or remove) the tenant allow-list of a tier or of the default tier. */
  async setTenantAllowList(request: {
    binding: `tier:${InferenceTier}` | typeof DEFAULT_TIER_BINDING;
    allowList: string[] | null;
  }): Promise<void> {
    await this.writes.setTenantAllowList(request.binding, request.allowList);
  }

  /** Define (or, with `null`, remove) an app-level alias. */
  async setAlias(request: {
    name: string;
    alias: InferenceAlias | null;
  }): Promise<void> {
    const binding = `alias:${request.name}`;
    if (!INFERENCE_BINDING_NAME_PATTERN.test(String(request.name))) {
      throw new InferenceBindingValueError(binding, 'invalid alias name');
    }
    if (request.alias !== null) {
      await this.assertConfigStaysValid('app', APP_INFERENCE_SCOPE_ID, {
        aliases: { [request.name]: request.alias },
      });
    }
    await this.writes.setValue(
      binding,
      'app',
      APP_INFERENCE_SCOPE_ID,
      request.alias,
      {
        // After authorization: the check reads rows of every tenant.
        beforeWrite: (normalized) =>
          normalized === null
            ? this.assertNotReferenced('alias', request.name)
            : Promise.resolve(),
      },
    );
  }

  /** Store (or, with `null`, remove) an app-level fusion config entry (#4753 shape). */
  async setFusion(request: {
    name: string;
    definition: Record<string, unknown> | null;
  }): Promise<void> {
    const binding = `fusion:${request.name}`;
    if (!INFERENCE_BINDING_NAME_PATTERN.test(String(request.name))) {
      throw new InferenceBindingValueError(binding, 'invalid fusion name');
    }
    if (request.definition !== null) {
      // Credential members are refused first (never echoed as config
      // issues), then a definition that adds a structural issue (#4800).
      const normalized = normalizeFusionDefinition(binding, request.definition);
      await this.assertConfigStaysValid('app', APP_INFERENCE_SCOPE_ID, {
        fusions: {
          [request.name]: normalized as unknown as InferenceFusionDefinition,
        },
      });
    }
    await this.writes.setValue(
      binding,
      'app',
      APP_INFERENCE_SCOPE_ID,
      request.definition,
      {
        // After authorization: the check reads rows of every tenant.
        beforeWrite: (normalized) =>
          normalized === null
            ? this.assertNotReferenced('fusion', request.name)
            : Promise.resolve(),
      },
    );
  }

  /**
   * Refuse removing an app alias or fusion that a stored binding (any
   * scope, any tenant) or the config still names, unless config or the
   * registry keeps defining it. Otherwise the removal would leave dangling
   * references that fail at call time.
   */
  private async assertNotReferenced(
    kind: 'alias' | 'fusion',
    name: string,
  ): Promise<void> {
    const config = this.readConfig() as InferenceSettingsConfig | undefined;
    const defined =
      kind === 'alias'
        ? Object.hasOwn(config?.aliases ?? {}, name)
        : Object.hasOwn(config?.fusions ?? {}, name) ||
          [...(this.options.registryFusions ?? defaultRegistryFusions)()].some(
            (fusion) => fusion?.key === name,
          );
    if (defined) return;
    const referrers: string[] = [];
    for (const [tier, target] of Object.entries(config?.tiers ?? {})) {
      if (bindingRefersTo(`tier:${tier}`, target, kind, name)) {
        referrers.push(`config tiers.${tier}`);
      }
    }
    for (const [alias, definition] of Object.entries(config?.aliases ?? {})) {
      if (bindingRefersTo(`alias:${alias}`, definition, kind, name)) {
        referrers.push(`config aliases.${alias}`);
      }
    }
    // Every scope: a tenant row bound to this name would dangle too. Tenant
    // rows are only counted; the error never names another tenant.
    let tenantReferences = 0;
    for (const row of await this.overrides.list({})) {
      let value: unknown;
      try {
        value = row.getValue();
      } catch {
        continue;
      }
      if (!bindingRefersTo(row.binding, value, kind, name)) continue;
      if (row.tenantId) tenantReferences += 1;
      else referrers.push(row.binding);
    }
    if (referrers.length > 0 || tenantReferences > 0) {
      throw new InferenceBindingInUseError(
        `${kind}:${name}`,
        referrers,
        tenantReferences,
      );
    }
  }

  /**
   * Refuse a write that adds a config issue (unknown alias, cycle, key
   * without endpoint, unknown preset) to the layered config it lands in.
   * Issues that already existed do not block unrelated writes.
   */
  private async assertConfigStaysValid(
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
    change: InferenceConfig,
  ): Promise<void> {
    const layers = await this.loadLayers(
      scopeType === 'tenant' ? scopeId : null,
    );
    const before = mergeSettingsConfigs(
      this.readConfig(),
      layers.app,
      layers.tenant,
    );
    const after = mergeSettingsConfigs(before, change);
    const seen = new Set(
      findInferenceConfigIssues(before).map(
        (issue) => `${issue.code}:${issue.path}`,
      ),
    );
    const added = findInferenceConfigIssues(after).filter(
      (issue) => !seen.has(`${issue.code}:${issue.path}`),
    );
    if (added.length > 0) throw new InferenceSettingsConfigError(added);
  }

  /**
   * Test connection for the default view: probe the endpoint's cheapest
   * list call (`./node`'s `probeInferenceCandidate`, 3 s). The stored key
   * record (from the host's `SecretService`) is sent only when the probe URL
   * is on the key's bound origin; no environment key is read.
   */
  async testConnection(
    input: InferenceConnectionInput,
    options: {
      key?: InferenceKeyRecord | null;
      fetch?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ): Promise<InferenceConnectionResult> {
    const candidate: InferenceCandidate = {};
    if (input.provider) candidate.provider = input.provider;
    if (input.preset) candidate.preset = input.preset;
    if (input.baseUrl) candidate.baseUrl = input.baseUrl;
    if (input.model) candidate.model = input.model;
    const url = inferenceProbeUrl(candidate);
    const apiKey = url ? inferenceKeyFor(options.key, url) : undefined;
    if (options.key && url && !apiKey) {
      let where = 'that endpoint';
      try {
        where = new URL(url).origin;
      } catch {
        // keep the generic wording
      }
      return {
        reachable: false,
        durationMs: 0,
        keySent: false,
        detail: `the stored key is bound to ${options.key.origin} and is never sent to ${where}; save a key for this endpoint`,
      };
    }
    // The probe refuses a key without its own baseUrl (#4752's pair rule), so
    // a key bound to a provider's default origin travels with that endpoint
    // named explicitly: the base of the very URL the key was checked against.
    const probed: InferenceCandidate =
      apiKey && url
        ? {
            ...candidate,
            baseUrl:
              candidate.baseUrl ?? url.replace(/\/(?:models|api\/tags)$/, ''),
            apiKey,
          }
        : candidate;
    const result = await probeInferenceCandidate(probed, {
      env: {},
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    return {
      ...result,
      detail: redactInferenceSecret(result.detail, apiKey),
      keySent: !!apiKey,
    };
  }

  /**
   * Per-candidate test for the alias editor. A candidate already in the
   * effective config (config file or an app row) reads its key from
   * `apiKeyEnv` (or its provider's variable) exactly as the doctor does,
   * sent only to its own endpoint; any other candidate (an unsaved edit) is
   * probed with no key at all.
   */
  async testCandidate(
    candidate: InferenceCandidate,
    options: {
      env?: Record<string, string | undefined>;
      fetch?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ): Promise<InferenceConnectionResult> {
    if (findKeyLike(candidate)) {
      throw new InferenceBindingValueError(
        'candidate',
        'a tested candidate never carries a literal key',
      );
    }
    // A key variable is read only for a candidate an authorized writer
    // already configured (config or an app row). An arbitrary candidate
    // naming `apiKeyEnv` with its own `baseUrl` would otherwise carry a
    // server key to an endpoint the caller chose.
    const configured = await this.isConfiguredCandidate(candidate);
    const result = await probeInferenceCandidate(candidate, {
      ...options,
      env: configured ? (options.env ?? process.env) : {},
    });
    return { ...result, keySent: false };
  }

  private async isConfiguredCandidate(
    candidate: InferenceCandidate,
  ): Promise<boolean> {
    const config = await this.getEffectiveConfig();
    const wanted = canonicalCandidate(candidate);
    return Object.values(config?.aliases ?? {}).some((alias) =>
      (alias?.candidates ?? []).some(
        (entry) => canonicalCandidate(entry) === wanted,
      ),
    );
  }

  /** `smrt doctor --ai` over the effective config for a tenant. */
  async doctor(
    options: {
      tenantId?: string | null;
      probe?: boolean;
      env?: Record<string, string | undefined>;
      fetch?: typeof fetch;
    } = {},
  ): Promise<InferenceDoctorReport> {
    const config = await this.getEffectiveConfig({
      tenantId: options.tenantId,
    });
    return checkInferenceBindings({
      config: config ?? {},
      probe: options.probe,
      env: options.env,
      fetch: options.fetch,
    });
  }

  /**
   * The app's transcript setting (#4781): effective values, the stored app
   * row, its revert preview, the env override and the retention window.
   * The same for every tenant (no tenant override).
   */
  async getTranscriptSettings(): Promise<InferenceTranscriptSettings> {
    const appRows = await this.overrides.getScopeMap(
      'app',
      APP_INFERENCE_SCOPE_ID,
    );
    const appValue = storedTranscriptSettings(appRows);
    const merged =
      this.options.transcriptsConfig ?? getInferenceTranscriptsConfig;
    const resolved = (layer: InferenceTranscriptsConfig | null) => {
      const value = merged(layer);
      return {
        enabled: value?.enabled === true,
        sample: value?.sample ?? DEFAULT_TRANSCRIPT_SAMPLE,
        maxBytes: value?.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES,
      };
    };
    const effective = resolved(appValue);
    const appRevert = resolved(null);
    // The env wins over every layer: if forcing either value through the
    // app layer gives the same answer, the env decided it.
    const forcedOn = resolved({ enabled: true }).enabled;
    const forcedOff = resolved({ enabled: false }).enabled;
    const envEnabled = forcedOn === forcedOff ? forcedOn : null;
    const config = merged(null);
    const supplyingLevel =
      envEnabled !== null
        ? 'env'
        : appValue?.enabled !== undefined
          ? 'app'
          : config?.enabled !== undefined
            ? 'config'
            : 'default';
    return {
      binding: TRANSCRIPTS_BINDING,
      ...effective,
      supplyingLevel,
      appValue,
      appRevert,
      envEnabled,
      retentionDays: transcriptRetentionDays(
        (this.options.retention ?? (() => coreConfig.toJSON().retention))(),
      ),
      promptOverrides: Object.keys(config?.prompts ?? {}).sort(),
    };
  }

  /**
   * Store (or, with `null`, remove) the app's transcript setting. Always
   * the app row: there is no tenant scope. Goes through the authorizer
   * (request `{ binding: 'transcripts', scopeType: 'app' }`); on success the
   * value is installed as core's app settings layer in this process.
   */
  async setTranscriptSettings(request: {
    settings: InferenceTranscriptSettingsValue | null;
  }): Promise<void> {
    await this.writes.setValue(
      TRANSCRIPTS_BINDING,
      'app',
      APP_INFERENCE_SCOPE_ID,
      request.settings,
    );
    applyStoredTranscriptSettings(
      await this.overrides.getScopeMap('app', APP_INFERENCE_SCOPE_ID),
    );
  }

  /**
   * The Usage tab: `reportAiUsage()` (#4751) grouped by model, tier, prompt
   * key, fusion and/or template hash. Pass `by: ['model']` where tier and
   * prompt tags do not exist yet; NULL dimensions are their own bucket,
   * never dropped. `transcripts: true` adds per-bucket transcript counts
   * (#4781; ids only, never content).
   */
  usage(
    options: {
      by?: InferenceUsageReportDimension[];
      since?: Date;
      until?: Date;
      tenantId?: string | null;
      transcripts?: boolean;
    } = {},
  ): Promise<AiUsageReport> {
    return reportAiUsage(this.overrides.db, {
      ...options,
      by: options.by && options.by.length > 0 ? options.by : ['model'],
    });
  }

  /** Local discovery for the model field (#4674's loopback probe). */
  async discoverModels(): Promise<
    Array<{ service: string; baseUrl: string; models: string[] }>
  > {
    const { discoverLocalInferenceModels } = await import(
      '@happyvertical/smrt-core/byo-inference'
    );
    const found = await discoverLocalInferenceModels();
    return found
      .filter((entry) => entry.available)
      .map((entry) => ({
        service: entry.service,
        baseUrl: entry.baseUrl,
        models: entry.available ? entry.models : [],
      }));
  }

  /** Provider choices: #4674 presets, then the AI SDK provider list. */
  listProviderOptions(): InferenceProviderOption[] {
    const presets: InferenceProviderOption[] = INFERENCE_PRESET_IDS.map(
      (id) => {
        const preset = INFERENCE_PRESETS[id];
        return {
          id,
          label: PRESET_LABELS[id] ?? id,
          kind: 'preset',
          baseUrl: preset.baseUrl,
          requiresApiKey: preset.requiresApiKey,
          local: !preset.requiresApiKey,
        };
      },
    );
    const providers: InferenceProviderOption[] = AI_PROVIDER_TYPES.map(
      (id) => ({
        id,
        label: id,
        kind: 'provider' as const,
        requiresApiKey: !!getDefaultAIKeyEnvName(id),
        ...(id === 'litellm' || id === 'bifrost' ? { needsBaseUrl: true } : {}),
        ...(id === 'ollama' ? { local: true } : {}),
      }),
    );
    return [...presets, ...providers];
  }
}

function canonicalCandidate(candidate: InferenceCandidate): string {
  const fields = [
    'provider',
    'model',
    'baseUrl',
    'apiKeyEnv',
    'preset',
    'alias',
  ];
  return JSON.stringify(
    fields.map((field) => {
      const value = (candidate as Record<string, unknown>)[field];
      return typeof value === 'string' ? value.trim() : null;
    }),
  );
}

function findKeyLike(candidate: InferenceCandidate): boolean {
  return (
    typeof (candidate as Record<string, unknown>).apiKey === 'string' &&
    ((candidate as Record<string, unknown>).apiKey as string).length > 0
  );
}
