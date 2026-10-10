/** Session-backed consent and live authorization for the SDK OAuth server. */
import {
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationServer,
  type OAuthConsentContext,
  type OAuthIdentityProvider,
  OAuthServerError,
} from '@happyvertical/auth/server';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { JWTPayload } from 'jose';
import { UsersOAuthAuthorizationCollection } from '../collections/OAuthAuthorizationCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import type { UsersOAuthAuthorization } from '../models/OAuthAuthorization.js';
import { SMRT_OAUTH_GRANT_CLAIM } from './OAuthAuthorizationStorage.js';
import { withOAuthTransaction } from './oauth-transaction.js';
import { type SessionContext, SessionService } from './SessionService.js';

/** Every scope needs an explicit permission mapping; empty mappings allow any live session. */
export interface SmrtOAuthAuthorizationServiceOptions extends SmrtClassOptions {
  scopePermissions: Readonly<Record<string, readonly string[]>>;
}
/** Safe account-settings projection; excludes session credentials and token hashes. */
export interface SmrtOAuthGrantSummary {
  id: string;
  clientId: string;
  tenantId: string | null;
  scopes: string[];
  resource: string | null;
  createdAt: Date | null;
  revokedAt: Date | null;
}

/** Durable consent follows the existing session, including its ceiling and parent. */
export class SmrtOAuthAuthorizationService {
  private constructor(
    private readonly options: SmrtOAuthAuthorizationServiceOptions,
    private readonly sessions: SessionService,
    private readonly grants: UsersOAuthAuthorizationCollection,
  ) {}
  static async create(
    options: SmrtOAuthAuthorizationServiceOptions,
  ): Promise<SmrtOAuthAuthorizationService> {
    const sessions = await SessionService.create({
      ...options,
      autoExtend: false,
    });
    return new SmrtOAuthAuthorizationService(
      options,
      sessions,
      await UsersOAuthAuthorizationCollection.create({
        db: sessions.getDatabase(),
      }),
    );
  }
  /** Suitable for createAuthorizationServer({ identity: service.identity }). */
  readonly identity: OAuthIdentityProvider & {
    revalidateConsent: (
      context: OAuthConsentContext,
      grant: {
        clientId: string;
        subject: string;
        tenantId?: string;
        scopes: readonly string[];
        resource?: string;
      },
    ) => Promise<OAuthConsentContext | null>;
  } = {
    refreshConsent: (context, grant) => this.revalidateConsent(context, grant),
    revalidateConsent: (context, grant) =>
      this.revalidateConsent(context, grant),
  };
  private async liveSession(sessionId: string): Promise<SessionContext | null> {
    const context = await this.sessions.loadSessionContext(sessionId);
    if (!context) return null;
    if (context.tenantId) {
      if (!context.tenantAuthorization?.membershipId) return null;
      const tenant = await (
        await TenantCollection.create({ db: this.sessions.getDatabase() })
      ).get(context.tenantId);
      if (!tenant?.isActive()) return null;
    }
    return context;
  }
  private permits(context: SessionContext, scopes: readonly string[]): boolean {
    return scopes.every(
      (scope) =>
        Object.hasOwn(this.options.scopePermissions, scope) &&
        this.options.scopePermissions[scope].every((permission) =>
          context.permissions.includes(permission),
        ),
    );
  }
  /** Call only after an explicit user consent action; the session is loaded again. */
  async approve(
    server: OAuthAuthorizationServer,
    request: OAuthAuthorizationRequest,
    sessionId: string,
  ) {
    const context = await this.liveSession(sessionId);
    if (!context || !this.permits(context, request.scopes))
      throw new OAuthServerError('access_denied', 'Authorization denied.', 403);
    const row = await this.grants.create({
      subject: context.user.id as string,
      sessionId,
      clientId: request.clientId,
      tenantId: context.tenantId,
      scopes: JSON.stringify(request.scopes),
      permissionCeiling: JSON.stringify(context.permissions),
      resource: request.resource ?? null,
      revokedAt: null,
      _insertOnly: true,
    });
    await row.save();
    try {
      return await server.approve(request, {
        subject: context.user.id as string,
        ...(context.tenantId ? { tenantId: context.tenantId } : {}),
        claims: { [SMRT_OAUTH_GRANT_CLAIM]: row.id as string },
      });
    } catch (error) {
      await this.revokeOwned(context.user.id as string, row.id as string);
      throw error;
    }
  }
  private async resolve(
    grantId: unknown,
    subject: unknown,
    tenantId: unknown,
    clientId: unknown,
    scopes: readonly string[],
    resource?: unknown,
  ): Promise<SessionContext | null> {
    if (
      typeof grantId !== 'string' ||
      typeof subject !== 'string' ||
      typeof clientId !== 'string'
    )
      return null;
    const grant = await this.grants.get(grantId);
    if (
      !grant ||
      grant.revokedAt ||
      grant.subject !== subject ||
      grant.clientId !== clientId ||
      (grant.tenantId ?? undefined) !== (tenantId ?? undefined) ||
      (grant.resource && grant.resource !== resource) ||
      scopes.some((scope) => !grant.getScopes().includes(scope))
    )
      return null;
    const context = await this.liveSession(grant.sessionId);
    if (
      !context ||
      context.user.id !== grant.subject ||
      context.tenantId !== grant.tenantId ||
      !this.permits(context, scopes) ||
      scopes.some((scope) =>
        this.options.scopePermissions[scope]?.some(
          (permission) => !grant.getPermissionCeiling().includes(permission),
        ),
      )
    )
      return null;
    // Authorization mutations racing the session load must not return a stale grant.
    const current = await this.grants.get(grantId);
    if (!current || current.revokedAt) return null;
    const allowed = new Set(
      scopes.flatMap((scope) => this.options.scopePermissions[scope] ?? []),
    );
    const permissions = context.permissions.filter((permission) =>
      allowed.has(permission),
    );
    return { ...context, permissions, permissionCeiling: permissions };
  }
  private async revalidateConsent(
    context: OAuthConsentContext,
    grant: {
      clientId: string;
      subject: string;
      tenantId?: string;
      scopes: readonly string[];
      resource?: string;
    },
  ): Promise<OAuthConsentContext | null> {
    const live = await this.resolve(
      context.claims?.[SMRT_OAUTH_GRANT_CLAIM],
      grant.subject,
      grant.tenantId,
      grant.clientId,
      grant.scopes,
      grant.resource,
    );
    return live &&
      context.subject === grant.subject &&
      context.tenantId === grant.tenantId
      ? context
      : null;
  }
  /** Call after SDK signature/audience/revocation verification, never on decoded-only JWTs. */
  async validateAccessTokenClaims(
    payload: JWTPayload,
  ): Promise<SessionContext | null> {
    if (typeof payload.scope !== 'string') return null;
    return this.resolve(
      payload[SMRT_OAUTH_GRANT_CLAIM],
      payload.sub,
      payload.tenant_id,
      payload.client_id,
      payload.scope.split(' ').filter(Boolean),
      payload.aud,
    );
  }
  /** Lists only the current authenticated user's consent decisions. */
  async listGrants(sessionId: string): Promise<SmrtOAuthGrantSummary[]> {
    const context = await this.liveSession(sessionId);
    if (!context)
      throw new OAuthServerError('access_denied', 'Sign in required.', 401);
    const result = await this.sessions
      .getDatabase()
      .query(
        'SELECT id FROM users_oauth_authorizations WHERE subject = ? ORDER BY created_at DESC',
        context.user.id,
      );
    const grants: SmrtOAuthGrantSummary[] = [];
    for (const row of result.rows) {
      const grant = await this.grants.get(String(row.id));
      if (grant) grants.push(this.summary(grant));
    }
    return grants;
  }
  /** Revocation is idempotent and confined to the authenticated subject. */
  async revokeGrant(sessionId: string, grantId: string): Promise<boolean> {
    const context = await this.liveSession(sessionId);
    if (!context)
      throw new OAuthServerError('access_denied', 'Sign in required.', 401);
    return this.revokeOwned(context.user.id as string, grantId);
  }
  private async revokeOwned(
    subject: string,
    grantId: string,
  ): Promise<boolean> {
    const db = this.sessions.getDatabase();
    if (!db.transaction)
      throw new Error('OAuth revocation requires transaction support.');
    return withOAuthTransaction(db, async (db) => {
      const now = new Date().toISOString();
      const locked = await db.query(
        'UPDATE users_oauth_authorizations SET revoked_at = ?, updated_at = ? WHERE id = ? AND subject = ?',
        now,
        now,
        grantId,
        subject,
      );
      if (locked.rowCount !== 1) return false;
      await db.query(
        'UPDATE users_oauth_authorization_codes SET consumed_at = ? WHERE authorization_id = ? AND consumed_at IS NULL',
        now,
        grantId,
      );
      await db.query(
        'UPDATE users_oauth_refresh_families SET revoked_at = ? WHERE authorization_id = ?',
        now,
        grantId,
      );
      await db.query(
        'UPDATE users_oauth_refresh_grants SET revoked_at = ? WHERE authorization_id = ?',
        now,
        grantId,
      );
      return true;
    });
  }
  private summary(grant: UsersOAuthAuthorization): SmrtOAuthGrantSummary {
    return {
      id: grant.id as string,
      clientId: grant.clientId,
      tenantId: grant.tenantId,
      scopes: grant.getScopes(),
      resource: grant.resource,
      createdAt: grant.created_at ?? null,
      revokedAt: grant.revokedAt,
    };
  }
}
