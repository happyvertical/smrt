import type { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import type { PromptOverride } from './models/PromptOverride.js';
import type { PromptOverrideScopeType } from './types.js';

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
    let allowed = false;
    try {
      allowed = (await this.authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new PromptOverrideAuthorizationError(request);
  }
}
