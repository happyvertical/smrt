/**
 * ConnectState: one in-flight credential connect (OAuth 2.0 / OIDC redirect).
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';

export interface ConnectStateOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  kind?: string;
  state?: string;
  codeVerifier?: string | null;
  redirectUri?: string;
  scopes?: string[];
  initiatedByUserId?: string | null;
  returnTo?: string | null;
  expiresAt?: Date;
}

/**
 * A single-use, tenant- and user-bound record that carries a connect across a
 * provider redirect: the CSRF state, the PKCE verifier, the redirect URI and
 * the signed-in user who started it. Created by `beginConnect`, burned by
 * `consumeConnect`. Never exposed through generated REST, MCP or CLI: the
 * verifier and state are credentials.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ConnectState extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The provider or flow this state belongs to, for example `x` or `mail:stalwart`. */
  @field({ description: 'The provider or flow this connect belongs to.' })
  kind = '';

  /** The unguessable CSRF value round-tripped through the provider. */
  @field({ description: 'The CSRF value sent to the provider.' })
  state = '';

  @field({ description: 'The PKCE code verifier.', sensitive: true })
  codeVerifier: string | null = null;

  @field({ description: 'The callback URL the provider returns to.' })
  redirectUri = '';

  @field({ description: 'The OAuth scopes requested.' })
  scopes: string[] = [];

  /** The user who started the connect; the callback must be made by the same user. */
  @crossPackageRef('@happyvertical/smrt-users:User')
  initiatedByUserId: string | null = null;

  /** A same-origin path to return to; the host validates before redirecting. */
  @field({ description: 'The same-origin path to return to afterwards.' })
  returnTo: string | null = null;

  @field({ description: 'When this connect link stops working.' })
  expiresAt: Date = new Date(Date.now() + 10 * 60 * 1000);

  constructor(options: ConnectStateOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.state !== undefined) this.state = options.state;
    if (options.codeVerifier !== undefined)
      this.codeVerifier = options.codeVerifier;
    if (options.redirectUri !== undefined)
      this.redirectUri = options.redirectUri;
    if (options.scopes !== undefined) this.scopes = options.scopes;
    if (options.initiatedByUserId !== undefined)
      this.initiatedByUserId = options.initiatedByUserId;
    if (options.returnTo !== undefined) this.returnTo = options.returnTo;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
  }

  get isExpired(): boolean {
    return Date.now() >= this.expiresAt.getTime();
  }
}
