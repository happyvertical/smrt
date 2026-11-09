/**
 * Authorized write path for `_smrt_inference_overrides` (#4754), mirroring
 * smrt-prompts' `PromptOverrideService` (#3013): every write names its exact
 * scope, asks the host authorizer, and fails closed. Tenant writes of a tier
 * or the default tier must also pass the tenant allow-list (the app row's
 * stored list, then the host's `tenantTargetPolicy` hook).
 */
import type { InferenceTier } from '@happyvertical/smrt-core';
import { APP_INFERENCE_SCOPE_ID } from '../models/InferenceOverride.js';
import type {
  InferenceOverrideCollection,
  InferenceOverrideScopeType,
} from '../models/InferenceOverrideCollection.js';
import {
  InferenceBindingValueError,
  inferenceTargetRef,
  isAllowedByList,
  normalizeAliasDefinition,
  normalizeAllowList,
  normalizeDefaultTier,
  normalizeFusionDefinition,
  normalizeTierTarget,
  normalizeTranscriptSettings,
  parseInferenceBinding,
} from './targets.js';

/** One override write the host must authorize before it runs. */
export interface InferenceOverrideWriteRequest {
  operation: 'set' | 'remove' | 'allow-list';
  binding: string;
  scopeType: InferenceOverrideScopeType;
  scopeId: string;
  /** `set`: the normalized value (`null` reverts the scope to what it inherits). */
  value?: unknown;
  /** `allow-list`: the normalized list (`null` removes it). */
  tenantAllowList?: string[] | null;
}

/**
 * The host's authorization decision for one write. Return `true` only when
 * the current caller may write that exact scope; anything else (including a
 * throw) denies.
 */
export type InferenceOverrideAuthorizer = (
  request: InferenceOverrideWriteRequest,
) => boolean | Promise<boolean>;

/** What the tenant-target policy hook is asked. */
export interface InferenceTenantTargetRequest {
  binding: string;
  /** The tier being bound (`tier:*` bindings). */
  tier?: InferenceTier;
  /** The allow-list reference of the requested target (`model:…`, `alias:…`, `fusion:…`, `tier:…`). */
  ref: string;
  /** The normalized target (a tier target, or a tier name for `default-tier`). */
  value: unknown;
  tenantId: string;
}

/**
 * The code half of the tenant allow-list, after the stored list on the app
 * row: return `true` only when the tenant may bind `ref`. This is the hook
 * #4667 uses to cap the maximum hosted tier per plan. It runs on every
 * tenant write and on every read that layers a tenant row, so narrowing it
 * stops an existing tenant binding from taking effect.
 */
export type InferenceTenantTargetPolicy = (
  request: InferenceTenantTargetRequest,
) => boolean | Promise<boolean>;

/** Thrown when the authorizer does not return `true`. Nothing is written. */
export class InferenceOverrideAuthorizationError extends Error {
  readonly status = 403;
  constructor(readonly request: InferenceOverrideWriteRequest) {
    super(
      `Inference override ${request.operation} denied for ${request.scopeType} scope`,
    );
    this.name = 'InferenceOverrideAuthorizationError';
  }
}

/** Thrown when a tenant write names a target the allow-list does not open. Nothing is written. */
export class InferenceTenantTargetNotAllowedError extends Error {
  readonly status = 403;
  constructor(
    readonly binding: string,
    readonly ref: string,
  ) {
    super(
      `Tenants may not bind ${binding} to ${ref}: not on the tenant allow-list`,
    );
    this.name = 'InferenceTenantTargetNotAllowedError';
  }
}

/** Thrown for a scope the layered read never consults. Checked before the authorizer. */
export class InvalidInferenceScopeError extends Error {
  readonly status = 400;
  constructor(
    readonly scopeType: string,
    readonly scopeId: string,
    reason: string,
  ) {
    super(`Invalid inference override scope (${scopeType}): ${reason}`);
    this.name = 'InvalidInferenceScopeError';
  }
}

/** Reject any scope the layered read does not consult. */
export function assertValidInferenceScope(
  scopeType: InferenceOverrideScopeType,
  scopeId: string,
): void {
  if (scopeType !== 'app' && scopeType !== 'tenant') {
    throw new InvalidInferenceScopeError(
      String(scopeType),
      String(scopeId),
      'scope type must be "app" or "tenant"',
    );
  }
  if (typeof scopeId !== 'string') {
    throw new InvalidInferenceScopeError(
      scopeType,
      String(scopeId),
      'scope id must be a string',
    );
  }
  if (scopeType === 'app' && scopeId !== APP_INFERENCE_SCOPE_ID) {
    throw new InvalidInferenceScopeError(
      scopeType,
      scopeId,
      `the app scope is only ever "${APP_INFERENCE_SCOPE_ID}"`,
    );
  }
  if (
    scopeType === 'tenant' &&
    (!scopeId.trim() ||
      scopeId !== scopeId.trim() ||
      scopeId === APP_INFERENCE_SCOPE_ID)
  ) {
    throw new InvalidInferenceScopeError(
      scopeType,
      scopeId,
      'a tenant scope id must be non-blank, already trimmed, and not the app scope id',
    );
  }
}

/** Normalize the value of one binding (throws {@link InferenceBindingValueError}). */
export function normalizeBindingValue(
  binding: string,
  value: unknown,
): unknown {
  const parsed = parseInferenceBinding(binding);
  if (!parsed) {
    throw new InferenceBindingValueError(String(binding), 'unknown binding id');
  }
  switch (parsed.kind) {
    case 'tier':
      return normalizeTierTarget(binding, value);
    case 'default-tier':
      return normalizeDefaultTier(binding, value);
    case 'transcripts':
      return normalizeTranscriptSettings(binding, value);
    case 'alias':
      return normalizeAliasDefinition(binding, value);
    case 'fusion':
      return normalizeFusionDefinition(binding, value);
  }
}

/** The allow-list reference of a normalized tier or default-tier value. */
export function bindingValueRef(binding: string, value: unknown): string {
  if (binding === 'default-tier') return `tier:${String(value)}`;
  return inferenceTargetRef(value as Parameters<typeof inferenceTargetRef>[0]);
}

/**
 * Whether a tenant may hold `value` for `binding`: the app row's stored
 * list, then the policy hook. A throwing policy denies.
 */
export async function isTenantValueAllowed(
  binding: string,
  value: unknown,
  tenantId: string,
  allowList: readonly string[] | null,
  policy: InferenceTenantTargetPolicy | undefined,
): Promise<boolean> {
  const ref = bindingValueRef(binding, value);
  if (!isAllowedByList(ref, allowList)) return false;
  if (!policy) return true;
  const parsed = parseInferenceBinding(binding);
  try {
    return (
      (await policy({
        binding,
        tier:
          parsed?.kind === 'tier' ? (parsed.name as InferenceTier) : undefined,
        ref,
        value,
        tenantId,
      })) === true
    );
  } catch {
    return false;
  }
}

/** Options for {@link InferenceOverrideService}. */
export interface InferenceOverrideServiceOptions {
  /** See {@link InferenceTenantTargetPolicy}. */
  tenantTargetPolicy?: InferenceTenantTargetPolicy;
}

/**
 * The only write path a host should use for `_smrt_inference_overrides`.
 * Construct it with an authorizer bound to the current caller; every write
 * asks it first and fails closed.
 */
export class InferenceOverrideService {
  constructor(
    private readonly overrides: InferenceOverrideCollection,
    private readonly authorize: InferenceOverrideAuthorizer,
    private readonly options: InferenceOverrideServiceOptions = {},
  ) {}

  /**
   * Set (or, with `null`, revert) one binding at one scope. Tenants may write
   * only `tier:*` and `default-tier`, and only an allow-listed target;
   * reverting is always allowed.
   *
   * @throws {InvalidInferenceScopeError} for a scope nothing reads.
   * @throws {InferenceBindingValueError} for an invalid binding or value.
   * @throws {InferenceOverrideAuthorizationError} when the authorizer declines.
   * @throws {InferenceTenantTargetNotAllowedError} when the allow-list refuses.
   */
  async setValue(
    binding: string,
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
    value: unknown,
    options: {
      /**
       * Runs after the authorizer allowed the write and before it lands; a
       * check that reads other rows belongs here, never before
       * authorization.
       */
      beforeWrite?: (normalized: unknown) => Promise<void>;
    } = {},
  ): Promise<void> {
    assertValidInferenceScope(scopeType, scopeId);
    const normalized = normalizeBindingValue(binding, value);
    const parsed = parseInferenceBinding(binding);
    if (
      scopeType === 'tenant' &&
      (parsed?.kind === 'alias' || parsed?.kind === 'fusion')
    ) {
      throw new InferenceBindingValueError(
        binding,
        'aliases and fusions are defined at the app scope only',
      );
    }
    // Tenants cannot override transcripts (owner decision, #4781).
    if (scopeType === 'tenant' && parsed?.kind === 'transcripts') {
      throw new InferenceBindingValueError(
        binding,
        'the transcript setting is app scope only',
      );
    }
    await this.require({
      operation: normalized === null ? 'remove' : 'set',
      binding,
      scopeType,
      scopeId,
      value: normalized,
    });
    if (scopeType === 'tenant' && normalized !== null) {
      const app = await this.overrides.findByScope(
        binding,
        'app',
        APP_INFERENCE_SCOPE_ID,
      );
      const allowed = await isTenantValueAllowed(
        binding,
        normalized,
        scopeId,
        app?.getTenantAllowList() ?? null,
        this.options.tenantTargetPolicy,
      );
      if (!allowed) {
        throw new InferenceTenantTargetNotAllowedError(
          binding,
          bindingValueRef(binding, normalized),
        );
      }
    }
    await options.beforeWrite?.(normalized);
    await this.overrides.setOverride(binding, scopeType, scopeId, {
      target: normalized,
    });
  }

  /**
   * Set (or, with `null`, remove) the tenant allow-list of a `tier:*` or
   * `default-tier` binding. The list lives on the app row.
   */
  async setTenantAllowList(
    binding: string,
    allowList: string[] | null,
  ): Promise<void> {
    const parsed = parseInferenceBinding(binding);
    if (!parsed || (parsed.kind !== 'tier' && parsed.kind !== 'default-tier')) {
      throw new InferenceBindingValueError(
        String(binding),
        'only tier and default-tier bindings carry a tenant allow-list',
      );
    }
    const normalized = normalizeAllowList(binding, allowList);
    await this.require({
      operation: 'allow-list',
      binding,
      scopeType: 'app',
      scopeId: APP_INFERENCE_SCOPE_ID,
      tenantAllowList: normalized,
    });
    await this.overrides.setOverride(binding, 'app', APP_INFERENCE_SCOPE_ID, {
      tenantAllowList: normalized,
    });
  }

  /** Delete the whole row (value and, on the app row, the allow-list). */
  async removeOverride(
    binding: string,
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
  ): Promise<boolean> {
    assertValidInferenceScope(scopeType, scopeId);
    if (!parseInferenceBinding(binding)) {
      throw new InferenceBindingValueError(
        String(binding),
        'unknown binding id',
      );
    }
    await this.require({ operation: 'remove', binding, scopeType, scopeId });
    return this.overrides.removeOverride(binding, scopeType, scopeId);
  }

  private async require(request: InferenceOverrideWriteRequest): Promise<void> {
    let allowed = false;
    try {
      allowed = (await this.authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new InferenceOverrideAuthorizationError(request);
  }
}
