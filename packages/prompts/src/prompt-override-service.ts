import type { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import type { PromptOverride } from './models/PromptOverride.js';
import { APP_PROMPT_SCOPE_ID, type PromptOverrideScopeType } from './types.js';

/** One override write the host must authorize before it runs (mirrors #3013). */
export interface PromptOverrideWriteRequest {
  operation: 'set' | 'remove';
  key: string;
  scopeType: PromptOverrideScopeType;
  scopeId: string;
  /** Present for `set`. `null` clears the template field. */
  template?: string | null;
}

/**
 * The host's explicit authorization decision for one override write. Return
 * `true` only when the current caller may write that exact scope; anything
 * else denies.
 */
export type PromptOverrideAuthorizer = (
  request: PromptOverrideWriteRequest,
) => boolean | Promise<boolean>;

/** Thrown when the authorizer does not return `true`. Nothing is written. */
export class PromptOverrideAuthorizationError extends Error {
  readonly status = 403;
  constructor(readonly request: PromptOverrideWriteRequest) {
    super(
      `Prompt override ${request.operation} denied for ${request.scopeType} scope`,
    );
    this.name = 'PromptOverrideAuthorizationError';
  }
}

/**
 * Thrown when a write names a scope the resolver never reads: an unknown scope
 * type, an app scope other than {@link APP_PROMPT_SCOPE_ID}, or a blank /
 * untrimmed / non-string tenant id. Checked before the authorizer runs, so a
 * malformed tenant scope can never resolve to the app-wide row. Nothing is
 * written.
 */
export class InvalidPromptScopeError extends Error {
  readonly status = 400;
  constructor(
    readonly scopeType: string,
    readonly scopeId: string,
    reason: string,
  ) {
    super(`Invalid prompt override scope (${scopeType}): ${reason}`);
    this.name = 'InvalidPromptScopeError';
  }
}

/** Reject any scope the resolver does not read (see {@link InvalidPromptScopeError}). */
export function assertValidPromptScope(
  scopeType: PromptOverrideScopeType,
  scopeId: string,
): void {
  if (scopeType !== 'app' && scopeType !== 'tenant') {
    throw new InvalidPromptScopeError(
      String(scopeType),
      String(scopeId),
      'scope type must be "app" or "tenant"',
    );
  }
  if (typeof scopeId !== 'string') {
    throw new InvalidPromptScopeError(
      scopeType,
      String(scopeId),
      'scope id must be a string',
    );
  }
  if (scopeType === 'app' && scopeId !== APP_PROMPT_SCOPE_ID) {
    throw new InvalidPromptScopeError(
      scopeType,
      scopeId,
      `the app scope is only ever "${APP_PROMPT_SCOPE_ID}"`,
    );
  }
  if (
    scopeType === 'tenant' &&
    (!scopeId.trim() ||
      scopeId !== scopeId.trim() ||
      scopeId === APP_PROMPT_SCOPE_ID)
  ) {
    throw new InvalidPromptScopeError(
      scopeType,
      scopeId,
      'a tenant scope id must be non-blank, already trimmed, and not the app scope id',
    );
  }
}

/**
 * Authorized write path for prompt overrides (mirrors `FeatureOverrideService`,
 * #3013). Override rows are authorization state for every scope and
 * `PromptOverride` is not tenant-scoped by the request context, so generated
 * surfaces are closed. Hosts that let callers change prompt text construct
 * this service with an authorizer bound to the current caller and write
 * through it; every write asks the authorizer first and fails closed.
 */
export class PromptOverrideService {
  constructor(
    private readonly overrides: PromptOverrideCollection,
    private readonly authorize: PromptOverrideAuthorizer,
  ) {}

  async setTemplateOverride(
    key: string,
    scopeType: PromptOverrideScopeType,
    scopeId: string,
    template: string | null,
  ): Promise<PromptOverride> {
    await this.require({ operation: 'set', key, scopeType, scopeId, template });
    return this.overrides.setTemplateOverride(
      key,
      scopeType,
      scopeId,
      template,
    );
  }

  async removeOverride(
    key: string,
    scopeType: PromptOverrideScopeType,
    scopeId: string,
  ): Promise<boolean> {
    await this.require({ operation: 'remove', key, scopeType, scopeId });
    return this.overrides.removeOverride(key, scopeType, scopeId);
  }

  private async require(request: PromptOverrideWriteRequest): Promise<void> {
    assertValidPromptScope(request.scopeType, request.scopeId);
    let allowed = false;
    try {
      allowed = (await this.authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new PromptOverrideAuthorizationError(request);
  }
}
