/**
 * Shared OIDC test-IdP harness: a real HTTP server implementing discovery,
 * JWKS, token, and userinfo endpoints with jose-signed ID tokens. Extracted
 * from oidc-login-service.test.ts so the mobile handler suite (issue #1748)
 * exercises the same provider-generic PKCE surface instead of inventing a
 * second mock.
 */

import { Buffer } from 'node:buffer';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  BackfillTracker,
  type DatabaseInterface,
} from '@happyvertical/smrt-core/migrations';
import { PROFILE_EMAIL_KEY_BACKFILL_NAME } from '@happyvertical/smrt-profiles';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { USER_EMAIL_KEY_BACKFILL_NAME } from '../../migrations/backfillUserEmailKeys.js';

export interface OidcTestServerOptions {
  authorizationResponseIssuerSupported?: boolean;
  audience?: string | string[];
  authorizedParty?: string;
  idTokenEmailVerified?: boolean;
  includeEmailInIdToken?: boolean;
  userInfoEmailVerified?: boolean;
}

export interface OidcTestServer {
  close: () => Promise<void>;
  issuer: string;
  /** Nonce stamped into subsequently issued ID tokens. */
  setNonce: (value: string) => void;
  tokenRequests: Array<{ authorization?: string; params: URLSearchParams }>;
  userinfoRequests: Array<{ authorization?: string }>;
}

/**
 * Schema for the tables OIDC user provisioning touches
 * (`UserCollection.getOrCreateFromOidc`): the smrt-profiles trio plus users
 * and sessions. Extend with further DDL per suite as needed.
 */
export const OIDC_USERS_TEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS "_smrt_backfills" (
  "name" TEXT PRIMARY KEY NOT NULL,
  "applied_at" TIMESTAMP DEFAULT current_timestamp,
  "description" TEXT,
  "package_name" TEXT
);

CREATE TABLE IF NOT EXISTS "profile_types" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profile_types_slug_context_meta_type_idx" ON "profile_types" ("slug", "context", "_meta_type");
CREATE INDEX IF NOT EXISTS "profile_types_meta_type_idx" ON "profile_types" ("_meta_type");

CREATE TABLE IF NOT EXISTS "profiles" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "type_id" TEXT,
  "email" TEXT,
  "email_key" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_context_meta_type_idx" ON "profiles" ("slug", "context", "_meta_type");
CREATE INDEX IF NOT EXISTS "profiles_meta_type_idx" ON "profiles" ("_meta_type");
CREATE INDEX IF NOT EXISTS "profiles_email_key_idx" ON "profiles" ("email_key");

CREATE TABLE IF NOT EXISTS "oidc_profile_email_reservations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT NOT NULL,
  "email_key" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_profile_email_reservations_slug_context_idx" ON "oidc_profile_email_reservations" ("slug", "context");
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_profile_email_reservations_profile_id_idx" ON "oidc_profile_email_reservations" ("profile_id");
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_profile_email_reservations_email_key_idx" ON "oidc_profile_email_reservations" ("email_key");

CREATE TABLE IF NOT EXISTS "oidc_identities" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT NOT NULL,
  "provider" TEXT DEFAULT '',
  "issuer" TEXT DEFAULT '',
  "subject" TEXT DEFAULT '',
  "identity_key" TEXT,
  "email" TEXT DEFAULT '',
  "last_used_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_identities_slug_context_idx" ON "oidc_identities" ("slug", "context");
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_identities_identity_key_idx" ON "oidc_identities" ("identity_key");

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT DEFAULT '',
  "email" TEXT DEFAULT '',
  "email_key" TEXT,
  "status" TEXT,
  "last_login_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_slug_context_idx" ON "users" ("slug", "context");
CREATE UNIQUE INDEX IF NOT EXISTS "users_profile_id_idx" ON "users" ("profile_id");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key_idx" ON "users" ("email_key");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "user_id" TEXT DEFAULT '',
  "tenant_id" TEXT,
  "status" TEXT,
  "expires_at" TIMESTAMP,
  "user_agent" TEXT DEFAULT '',
  "ip_address" TEXT DEFAULT '',
  "last_accessed_at" TIMESTAMP,
  "data" JSON DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_slug_context_idx" ON "sessions" ("slug", "context");
`;

/** Mark a freshly-created, empty test schema ready for indexed OIDC reads. */
export async function prepareOidcEmailKeyBackfills(
  db: DatabaseInterface,
): Promise<void> {
  const tracker = new BackfillTracker({ db });
  await tracker.recordApplied(PROFILE_EMAIL_KEY_BACKFILL_NAME, {
    description: 'Canonical Profile identity email keys are current.',
    packageName: '@happyvertical/smrt-profiles',
  });
  await tracker.recordApplied(USER_EMAIL_KEY_BACKFILL_NAME, {
    description: 'Canonical User identity email keys are current.',
    packageName: '@happyvertical/smrt-users',
  });
}

const activeServers = new Set<Server>();

async function closeServer(server: Server): Promise<void> {
  if (!activeServers.has(server)) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  activeServers.delete(server);
}

/** Close every server started by this harness (call from `afterAll`). */
export async function closeAllOidcServers(): Promise<void> {
  await Promise.all([...activeServers].map((server) => closeServer(server)));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startOidcServer(
  options: OidcTestServerOptions = {},
): Promise<OidcTestServer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.kid = 'test-key';
  jwk.use = 'sig';

  let issuer = '';
  let nonce = '';
  const tokenRequests: Array<{
    authorization?: string;
    params: URLSearchParams;
  }> = [];
  const userinfoRequests: Array<{
    authorization?: string;
  }> = [];

  const server: Server = createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const url = new URL(request.url, issuer);

    if (url.pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        ...(options.authorizationResponseIssuerSupported === undefined
          ? {}
          : {
              authorization_response_iss_parameter_supported:
                options.authorizationResponseIssuerSupported,
            }),
        authorization_endpoint: `${issuer}/authorize`,
        issuer,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
      return;
    }

    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [jwk] });
      return;
    }

    if (url.pathname === '/token') {
      const body = await readBody(request);
      const params = new URLSearchParams(body);
      tokenRequests.push({
        authorization: request.headers.authorization,
        params,
      });

      const idTokenClaims: Record<string, unknown> = {
        nonce,
      };
      if (options.includeEmailInIdToken !== false) {
        idTokenClaims.email = 'dex.user@example.com';
        idTokenClaims.email_verified = options.idTokenEmailVerified ?? true;
        idTokenClaims.name = 'Dex User';
        idTokenClaims.preferred_username = 'dex-user';
      } else if (options.idTokenEmailVerified !== undefined) {
        idTokenClaims.email_verified = options.idTokenEmailVerified;
      }
      if (options.authorizedParty) {
        idTokenClaims.azp = options.authorizedParty;
      }

      const idToken = await new SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setAudience(options.audience ?? 'smrt-client')
        .setExpirationTime('5m')
        .setIssuedAt()
        .setIssuer(issuer)
        .setSubject('dex-user-123')
        .sign(privateKey);

      sendJson(response, 200, {
        access_token: 'access-token',
        expires_in: 3600,
        id_token: idToken,
        token_type: 'Bearer',
      });
      return;
    }

    if (url.pathname === '/userinfo') {
      userinfoRequests.push({
        authorization: request.headers.authorization,
      });
      sendJson(response, 200, {
        email: 'dex.user@example.com',
        email_verified: options.userInfoEmailVerified ?? true,
        name: 'Dex User',
        preferred_username: 'dex-user',
        sub: 'dex-user-123',
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start OIDC test server');
  }

  activeServers.add(server);
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    close: () => closeServer(server),
    issuer,
    setNonce: (value: string) => {
      nonce = value;
    },
    tokenRequests,
    userinfoRequests,
  };
}
