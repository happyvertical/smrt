import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { bumpInferenceOverrideGeneration } from '../settings/cache.js';
import {
  InferenceBindingValueError,
  normalizeAliasDefinition,
  normalizeAllowList,
  normalizeDefaultTier,
  normalizeFusionDefinition,
  normalizeTierTarget,
  normalizeTranscriptSettings,
  parseInferenceBinding,
} from '../settings/targets.js';

/** `context` (and `scopeId`) of the app-wide row. */
export const APP_INFERENCE_SCOPE_ID = '__app__';

export interface InferenceOverrideOptions extends SmrtObjectOptions {
  binding?: string;
  tenantId?: string | null;
  target?: string | null;
  tenantAllowList?: string | null;
}

function parseJson(binding: string, raw: string | null, what: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InferenceBindingValueError(binding, `${what} is not valid JSON`);
  }
}

// One row per (binding, scope): `tier:<tier>`, `default-tier`,
// `alias:<name>` or `fusion:<name>`, at the app scope (`tenantId = null`) or
// one tenant's. Rows are authorization state for every scope and `tenantId`
// is an ordinary settable field, not request-derived tenant scoping, so the
// generated REST, CLI and MCP surfaces are closed (mirrors
// `_smrt_prompt_overrides`, #3013). Hosts write through
// `InferenceOverrideService`, which asks a host authorizer before every write
// and fails closed. Keys never live here: `save()` refuses any credential-
// shaped member; keys go to smrt-secrets through the host.
@smrt({
  tableName: '_smrt_inference_overrides',
  conflictColumns: ['binding', 'context'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'idx_smrt_inference_overrides_tenant',
      columns: ['tenantId', 'binding'],
    },
  ],
})
export class InferenceOverride extends SmrtObject {
  @field({ required: true, requiredFor: 'identity' })
  binding: string = '';

  // Not tenant-scoped (any scope is writable through the authorized service),
  // but the value is a tenant id: uuid on PostgreSQL, like every tenant_id.
  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  /**
   * JSON of the bound value; `null` inherits the lower layer. Tier rows hold
   * a tier target, `default-tier` holds `{ tier }`, alias rows an alias, and
   * fusion rows a fusion config entry.
   */
  @field({ type: 'text', nullable: true })
  target: string | null = null;

  /**
   * App rows of `tier:*` and `default-tier` only: JSON array of the target
   * references a tenant may bind (`model:openai/*`, `alias:local`,
   * `fusion:review-pair`, `tier:good`, `*`). No list allows nothing. This is
   * the stored half of the tenant allow-list; the service's
   * `tenantTargetPolicy` hook is the code half (#4667 caps the maximum
   * hosted tier there).
   */
  @field({ type: 'text', nullable: true })
  tenantAllowList: string | null = null;

  constructor(options: InferenceOverrideOptions = {}) {
    super(options);
    if (options.binding !== undefined) this.binding = options.binding;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.target !== undefined) this.target = options.target;
    if (options.tenantAllowList !== undefined) {
      this.tenantAllowList = options.tenantAllowList;
    }
  }

  /** The parsed, validated stored value (`null` inherits). */
  getValue(): unknown {
    return this.normalizedValue();
  }

  /** The parsed allow-list (`null` when the row carries none). */
  getTenantAllowList(): string[] | null {
    return normalizeAllowList(
      this.binding,
      parseJson(this.binding, this.tenantAllowList, 'tenantAllowList'),
    );
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    this.validateOverride();
    // `context` is the uniqueness scope so the app row stays unique even
    // though `tenantId` is nullable (as in `_smrt_prompt_overrides`).
    this.context = this.tenantId ?? APP_INFERENCE_SCOPE_ID;
    const result = await super.save(options);
    bumpInferenceOverrideGeneration();
    return result;
  }

  override async delete(): Promise<void> {
    await super.delete();
    bumpInferenceOverrideGeneration();
  }

  private normalizedValue(): unknown {
    const parsed = parseInferenceBinding(this.binding);
    if (!parsed) {
      throw new InferenceBindingValueError(
        String(this.binding),
        'unknown binding id',
      );
    }
    const raw = parseJson(this.binding, this.target, 'target');
    switch (parsed.kind) {
      case 'tier':
        return normalizeTierTarget(this.binding, raw);
      case 'default-tier':
        return normalizeDefaultTier(this.binding, raw);
      case 'transcripts':
        return normalizeTranscriptSettings(this.binding, raw);
      case 'alias':
        return normalizeAliasDefinition(this.binding, raw);
      case 'fusion':
        return normalizeFusionDefinition(this.binding, raw);
    }
  }

  private validateOverride(): void {
    const parsed = parseInferenceBinding(this.binding);
    if (!parsed) {
      throw new InferenceBindingValueError(
        String(this.binding),
        'unknown binding id',
      );
    }
    if (this.tenantId !== null) {
      if (
        typeof this.tenantId !== 'string' ||
        !this.tenantId.trim() ||
        this.tenantId !== this.tenantId.trim() ||
        this.tenantId === APP_INFERENCE_SCOPE_ID
      ) {
        throw new InferenceBindingValueError(this.binding, 'invalid tenant id');
      }
      // Tenants bind tiers to allow-listed targets; they never define what a
      // name means. A tenant alias or fusion could redefine an allow-listed
      // name and bypass the list.
      if (parsed.kind === 'alias' || parsed.kind === 'fusion') {
        throw new InferenceBindingValueError(
          this.binding,
          'aliases and fusions are defined at the app scope only',
        );
      }
      // Tenants cannot override transcripts (owner decision, #4781).
      if (parsed.kind === 'transcripts') {
        throw new InferenceBindingValueError(
          this.binding,
          'the transcript setting is app scope only',
        );
      }
      if (this.tenantAllowList !== null) {
        throw new InferenceBindingValueError(
          this.binding,
          'the tenant allow-list lives on the app row',
        );
      }
    }
    if (
      this.tenantAllowList !== null &&
      parsed.kind !== 'tier' &&
      parsed.kind !== 'default-tier'
    ) {
      throw new InferenceBindingValueError(
        this.binding,
        'only tier and default-tier bindings carry a tenant allow-list',
      );
    }
    const value = this.normalizedValue();
    this.target = value === null ? null : JSON.stringify(value);
    const allowList = this.getTenantAllowList();
    this.tenantAllowList =
      allowList === null ? null : JSON.stringify(allowList);
  }
}
