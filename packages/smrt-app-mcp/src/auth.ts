/** Server-only OAuth protected-resource boundary. This is not an issuer. */
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { McpAppPrincipal } from './server.js';

export type McpDeploymentProfile = 'local' | 'self-hosted' | 'cloud';
export interface McpVerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly claims: Readonly<JWTPayload>;
}
export interface McpPrincipalMapping {
  id: string;
  tenantId?: string;
  kind?: string;
  roles?: string[];
}
export interface McpResourceAuthOptions {
  profile: McpDeploymentProfile;
  /** Exact public resource identifier; also the required token audience. */
  resource: string;
  /** Exact issuer identifier, including any trailing slash. */
  issuer: string;
  /** Operator-configured signing keys. Never derived from an untrusted token. */
  jwksUri: string;
  scopes: readonly string[];
  algorithms: readonly ('RS256' | 'ES256')[];
  /** Default at+jwt. Select JWT only for a provider that uses it for access tokens. */
  tokenType?: 'at+jwt' | 'JWT';
  /** Default true. Set false only for an explicitly single-tenant application. */
  requireTenant?: boolean;
  /** Re-run for every request; return null for revoked/disabled/unmapped users.
   * Resolve active tenant/membership in trusted application state, never request
   * arguments. Provider JWT revocation is NOT detected by offline validation.
   */
  resolvePrincipal(
    identity: McpVerifiedIdentity,
  ): Promise<McpPrincipalMapping | null>;
}

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
function validateUrl(value: string, profile: McpDeploymentProfile): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid MCP authorization URL.');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s"\\]/u.test(value) ||
    (profile === 'local'
      ? !loopback || !['http:', 'https:'].includes(url.protocol)
      : url.protocol !== 'https:')
  )
    throw new Error('Invalid MCP authorization URL for deployment profile.');
  return url;
}
function validString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    )
  );
}

export interface McpResourceAuth {
  /** Mount GET at this URL. Paths use RFC 9728's well-known path insertion. */
  readonly metadataUrl: string;
  metadataResponse(): Response;
  /** A failure response contains no token, claims or upstream error details. */
  authenticate(
    request: Request,
  ): Promise<
    | { ok: true; principal: McpAppPrincipal & { id: string } }
    | { ok: false; response: Response }
  >;
}

export function createMcpResourceAuth(
  options: McpResourceAuthOptions,
): McpResourceAuth {
  if (!['local', 'self-hosted', 'cloud'].includes(options.profile)) {
    throw new Error('Unknown MCP deployment profile.');
  }
  const resourceUrl = validateUrl(options.resource, options.profile);
  validateUrl(options.issuer, options.profile);
  validateUrl(options.jwksUri, options.profile);
  if (
    !options.algorithms.length ||
    options.algorithms.some((alg) => !['RS256', 'ES256'].includes(alg))
  ) {
    throw new Error('Explicit asymmetric MCP token algorithms are required.');
  }
  if (options.scopes.some((scope) => !scopePattern.test(scope))) {
    throw new Error('Invalid MCP OAuth scope.');
  }
  if (
    options.tokenType !== undefined &&
    !['at+jwt', 'JWT'].includes(options.tokenType)
  ) {
    throw new Error('Unsupported MCP access-token type.');
  }
  // Snapshot configuration so later caller mutation cannot broaden authority.
  const issuer = options.issuer;
  const resource = options.resource;
  const scopes = [...new Set(options.scopes)];
  const algorithms = [...options.algorithms];
  const tokenType = options.tokenType ?? 'at+jwt';
  const requireTenant = options.requireTenant !== false;
  const resolvePrincipal = options.resolvePrincipal;
  const keys = createRemoteJWKSet(new URL(options.jwksUri), {
    timeoutDuration: 5000,
  });
  const metadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`;
  function deny(error?: 'invalid_token' | 'insufficient_scope'): {
    ok: false;
    response: Response;
  } {
    const challenge = [
      `Bearer resource_metadata="${metadataUrl}"`,
      ...(scopes.length ? [`scope="${scopes.join(' ')}"`] : []),
      ...(error ? [`error="${error}"`] : []),
    ].join(', ');
    return {
      ok: false,
      response: new Response(null, {
        status: error === 'insufficient_scope' ? 403 : 401,
        headers: { 'WWW-Authenticate': challenge, 'Cache-Control': 'no-store' },
      }),
    };
  }
  return {
    metadataUrl,
    metadataResponse: () =>
      Response.json(
        {
          resource,
          authorization_servers: [issuer],
          scopes_supported: scopes,
          bearer_methods_supported: ['header'],
        },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    async authenticate(request) {
      const authorization = request.headers.get('authorization');
      if (!authorization) return deny();
      const match =
        /^Bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(
          authorization,
        );
      if (!match) return deny('invalid_token');
      try {
        const { payload } = await jwtVerify(match[1], keys, {
          issuer,
          audience: resource,
          algorithms,
          typ: tokenType,
          requiredClaims: ['iss', 'aud', 'sub', 'exp'],
          clockTolerance: 0,
        });
        if (!validString(payload.sub) || typeof payload.scope !== 'string')
          return deny('invalid_token');
        const granted = payload.scope === '' ? [] : payload.scope.split(' ');
        if (granted.some((scope) => !scopePattern.test(scope)))
          return deny('invalid_token');
        if (scopes.some((scope) => !granted.includes(scope)))
          return deny('insufficient_scope');
        const mapping = await resolvePrincipal(
          Object.freeze({
            issuer,
            subject: payload.sub,
            scopes: Object.freeze([...granted]),
            claims: Object.freeze(payload),
          }),
        );
        if (
          !mapping ||
          !validString(mapping.id) ||
          (requireTenant && !validString(mapping.tenantId)) ||
          (mapping.tenantId !== undefined && !validString(mapping.tenantId)) ||
          (mapping.kind !== undefined && !validString(mapping.kind)) ||
          (mapping.roles !== undefined &&
            (!Array.isArray(mapping.roles) ||
              !mapping.roles.every(validString)))
        ) {
          return deny('invalid_token');
        }
        return {
          ok: true,
          principal: {
            id: mapping.id,
            tenantId: mapping.tenantId,
            kind: mapping.kind,
            roles: mapping.roles ? [...mapping.roles] : undefined,
            scopes: [...granted],
          },
        };
      } catch {
        return deny('invalid_token');
      }
    },
  };
}
