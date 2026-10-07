/** Durable OAuth authorization-server state owned by smrt-users. */
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

export type OAuthTokenClaims = Record<string, string | number | boolean>;

function stringArray(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return [...value];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function tokenClaims(value: unknown): OAuthTokenClaims {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, item]) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean',
      ),
    ) as OAuthTokenClaims;
  }
  if (typeof value !== 'string') return {};
  try {
    return tokenClaims(JSON.parse(value));
  } catch {
    return {};
  }
}

@smrt({
  tableName: 'users_oauth_clients',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthClient extends SmrtObject {
  @field({ type: 'text', required: true, unique: true }) clientId = '';
  redirectUris = '[]';
  allowedScopes = '[]';
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' = 'none';
  @field({ nullable: true, sensitive: true }) secretHash: string | null = null;
  allowedResources = 'null';
  @field({ type: 'datetime' }) createdAt = new Date();
  getRedirectUris(): string[] {
    return stringArray(this.redirectUris);
  }
  getAllowedScopes(): string[] {
    return stringArray(this.allowedScopes);
  }
  getAllowedResources(): string[] | undefined {
    return this.allowedResources === 'null'
      ? undefined
      : stringArray(this.allowedResources);
  }
}

@smrt({
  tableName: 'users_oauth_authorization_codes',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthAuthorizationCode extends SmrtObject {
  @field({ nullable: true, indexed: true }) authorizationId: string | null =
    null;
  @field({ type: 'text', required: true, unique: true, sensitive: true })
  codeHash = '';
  @field({ type: 'text', indexed: true }) clientId = '';
  @field({ type: 'text', indexed: true }) subject = '';
  @field({ nullable: true, indexed: true }) tenantId: string | null = null;
  claims = '{}';
  redirectUri = '';
  scopes = '[]';
  @field({ nullable: true }) resource: string | null = null;
  codeChallenge = '';
  @field({ type: 'datetime', indexed: true }) expiresAt = new Date();
  @field({ type: 'datetime', nullable: true }) consumedAt: Date | null = null;
  getScopes(): string[] {
    return stringArray(this.scopes);
  }
  getClaims(): OAuthTokenClaims {
    return tokenClaims(this.claims);
  }
}

@smrt({
  tableName: 'users_oauth_refresh_grants',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthRefreshGrant extends SmrtObject {
  @field({ nullable: true, indexed: true }) authorizationId: string | null =
    null;
  @field({ type: 'text', required: true, unique: true, sensitive: true })
  tokenHash = '';
  @field({ type: 'text', indexed: true }) familyId = '';
  @field({ type: 'text', indexed: true }) clientId = '';
  @field({ type: 'text', indexed: true }) subject = '';
  @field({ nullable: true, indexed: true }) tenantId: string | null = null;
  claims = '{}';
  scopes = '[]';
  @field({ nullable: true }) resource: string | null = null;
  @field({ type: 'datetime', indexed: true }) expiresAt = new Date();
  @field({ type: 'datetime', nullable: true }) consumedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true, indexed: true })
  revokedAt: Date | null = null;
  getScopes(): string[] {
    return stringArray(this.scopes);
  }
  getClaims(): OAuthTokenClaims {
    return tokenClaims(this.claims);
  }
}

@smrt({
  tableName: 'users_oauth_access_token_revocations',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthAccessTokenRevocation extends SmrtObject {
  @field({ type: 'text', required: true, unique: true, sensitive: true }) jti =
    '';
  @field({ type: 'datetime', indexed: true }) expiresAt = new Date();
}

/** A consent decision bound to a server-side session; never exposes its bearer. */
@smrt({
  tableName: 'users_oauth_authorizations',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthAuthorization extends SmrtObject {
  @field({ type: 'text', indexed: true }) subject = '';
  @field({ type: 'text', sensitive: true }) sessionId = '';
  @field({ type: 'text', indexed: true }) clientId = '';
  @field({ nullable: true }) tenantId: string | null = null;
  scopes = '[]';
  permissionCeiling = '[]';
  @field({ nullable: true }) resource: string | null = null;
  @field({ type: 'datetime', nullable: true }) revokedAt: Date | null = null;
  getPermissionCeiling(): string[] {
    return stringArray(this.permissionCeiling);
  }
  getScopes(): string[] {
    return stringArray(this.scopes);
  }
}

/** Stable lock row: rotation and revocation always serialize on this family. */
@smrt({
  tableName: 'users_oauth_refresh_families',
  sensitive: true,
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class UsersOAuthRefreshFamily extends SmrtObject {
  @field({ nullable: true, indexed: true }) authorizationId: string | null =
    null;
  @field({ type: 'datetime', nullable: true }) revokedAt: Date | null = null;
}
