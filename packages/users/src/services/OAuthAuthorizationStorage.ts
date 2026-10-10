/** Durable OAuth state; all rotation and revocation writes use one executor. */

import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type {
  OAuthAuthorizationCodeGrant,
  OAuthAuthorizationStorage,
  OAuthClient,
  OAuthCodeConsumeResult,
  OAuthRefreshGrant,
  OAuthRefreshRotateResult,
} from '@happyvertical/auth/server';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  UsersOAuthAccessTokenRevocationCollection,
  UsersOAuthAuthorizationCodeCollection,
  UsersOAuthClientCollection,
  UsersOAuthRefreshFamilyCollection,
  UsersOAuthRefreshGrantCollection,
} from '../collections/OAuthAuthorizationCollection.js';
import type {
  UsersOAuthAuthorizationCode,
  UsersOAuthRefreshGrant,
} from '../models/OAuthAuthorization.js';
import { withOAuthTransaction } from './oauth-transaction.js';

/** Non-secret reference carried in access tokens; session credentials stay in storage. */
export const SMRT_OAUTH_GRANT_CLAIM = 'smrt_grant_id';
function authorizationId(grant: {
  claims?: Readonly<Record<string, string | number | boolean>>;
}): string | null {
  const id = grant.claims?.[SMRT_OAUTH_GRANT_CLAIM];
  return typeof id === 'string' ? id : null;
}
function codeGrant(
  row: UsersOAuthAuthorizationCode,
): OAuthAuthorizationCodeGrant {
  return {
    id: row.id as string,
    codeHash: row.codeHash,
    clientId: row.clientId,
    subject: row.subject,
    ...(row.tenantId ? { tenantId: row.tenantId } : {}),
    claims: row.getClaims(),
    redirectUri: row.redirectUri,
    scopes: row.getScopes(),
    ...(row.resource ? { resource: row.resource } : {}),
    codeChallenge: row.codeChallenge,
    expiresAt: row.expiresAt,
  };
}
function refreshGrant(row: UsersOAuthRefreshGrant): OAuthRefreshGrant {
  return {
    id: row.id as string,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    clientId: row.clientId,
    subject: row.subject,
    ...(row.tenantId ? { tenantId: row.tenantId } : {}),
    claims: row.getClaims(),
    scopes: row.getScopes(),
    ...(row.resource ? { resource: row.resource } : {}),
    expiresAt: row.expiresAt,
  };
}

/** Factory-created storage connections must reapply all required per-connection settings. */
export interface SmrtOAuthAuthorizationStorageOptions extends SmrtClassOptions {
  recoverDatabase?: () => Promise<DatabaseInterface>;
}

/** Maps SDK storage operations to atomic SQLite/PostgreSQL persistence. */
export class SmrtOAuthAuthorizationStorage
  implements OAuthAuthorizationStorage
{
  private constructor(
    private db: DatabaseInterface &
      Required<Pick<DatabaseInterface, 'transaction'>>,
    private readonly recoverDatabase?: () => Promise<DatabaseInterface>,
  ) {}
  private recovering: Promise<void> | null = null;
  private async execute<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const previous = this.db;
      try {
        return await action();
      } catch (error) {
        let cause: unknown = error;
        let invalidated = false;
        for (
          let depth = 0;
          depth < 6 && cause && typeof cause === 'object';
          depth++
        ) {
          const failure = cause as {
            connectionInvalidated?: boolean;
            cause?: unknown;
          };
          invalidated ||= failure.connectionInvalidated === true;
          cause = failure.cause;
        }
        const recover = this.recoverDatabase;
        if (!invalidated || !recover || attempt >= 6) throw error;
        if (this.db === previous) {
          this.recovering ??= (async () => {
            const db = await recover();
            if (!db.transaction)
              throw new Error('OAuth recovery requires transaction support.');
            this.db = db as typeof this.db;
          })().finally(() => {
            this.recovering = null;
          });
          await this.recovering;
        }
        await setTimeout(5 * 2 ** attempt);
      }
    }
  }
  static async create(
    options: SmrtOAuthAuthorizationStorageOptions,
  ): Promise<SmrtOAuthAuthorizationStorage> {
    const rows = await UsersOAuthClientCollection.create(
      options.recoverDatabase
        ? { ...options, db: await options.recoverDatabase() }
        : options,
    );
    if (!rows.db.transaction)
      throw new Error('OAuth storage requires transaction support.');
    return new SmrtOAuthAuthorizationStorage(
      rows.db as DatabaseInterface &
        Required<Pick<DatabaseInterface, 'transaction'>>,
      options.recoverDatabase,
    );
  }
  private async lockAuthorization(
    db: DatabaseInterface,
    id: string | null,
    now: Date,
  ): Promise<boolean> {
    if (!id) return true;
    const result = await db.query(
      'UPDATE users_oauth_authorizations SET updated_at = ? WHERE id = ? AND revoked_at IS NULL',
      now.toISOString(),
      id,
    );
    return result.rowCount === 1;
  }
  private async revokeAuthorization(
    db: DatabaseInterface,
    id: string | null,
    now: Date,
  ): Promise<void> {
    if (!id) return;
    const time = now.toISOString();
    await db.query(
      'UPDATE users_oauth_authorizations SET revoked_at = ?, updated_at = ? WHERE id = ?',
      time,
      time,
      id,
    );
    await db.query(
      'UPDATE users_oauth_authorization_codes SET consumed_at = ? WHERE authorization_id = ? AND consumed_at IS NULL',
      time,
      id,
    );
    await db.query(
      'UPDATE users_oauth_refresh_families SET revoked_at = ? WHERE authorization_id = ?',
      time,
      id,
    );
    await db.query(
      'UPDATE users_oauth_refresh_grants SET revoked_at = ? WHERE authorization_id = ?',
      time,
      id,
    );
  }
  async getClient(clientId: string): Promise<OAuthClient | null> {
    return this.execute(async () => {
      const client = await (
        await UsersOAuthClientCollection.create({ db: this.db })
      ).findByClientId(clientId);
      return client
        ? {
            id: client.clientId,
            redirectUris: client.getRedirectUris(),
            allowedScopes: client.getAllowedScopes(),
            tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
            ...(client.secretHash ? { secretHash: client.secretHash } : {}),
            ...(client.getAllowedResources() !== undefined
              ? { allowedResources: client.getAllowedResources() }
              : {}),
            createdAt: client.createdAt,
          }
        : null;
    });
  }
  async registerClient(client: OAuthClient): Promise<void> {
    return this.execute(async () => {
      const rows = await UsersOAuthClientCollection.create({ db: this.db });
      await (
        await rows.create({
          clientId: client.id,
          redirectUris: JSON.stringify(client.redirectUris),
          allowedScopes: JSON.stringify(client.allowedScopes),
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          secretHash: client.secretHash ?? null,
          allowedResources: JSON.stringify(client.allowedResources ?? null),
          createdAt: client.createdAt,
          _insertOnly: true,
        })
      ).save();
    });
  }
  async createAuthorizationCode(
    grant: OAuthAuthorizationCodeGrant,
  ): Promise<void> {
    return this.execute(async () => {
      await withOAuthTransaction(this.db, async (db) => {
        if (
          !(await this.lockAuthorization(
            db,
            authorizationId(grant),
            new Date(),
          ))
        )
          throw new Error('Authorization is revoked.');
        const rows = await UsersOAuthAuthorizationCodeCollection.create({ db });
        await (
          await rows.create({
            id: grant.id,
            authorizationId: authorizationId(grant),
            codeHash: grant.codeHash,
            clientId: grant.clientId,
            subject: grant.subject,
            tenantId: grant.tenantId ?? null,
            claims: JSON.stringify(grant.claims ?? {}),
            redirectUri: grant.redirectUri,
            scopes: JSON.stringify(grant.scopes),
            resource: grant.resource ?? null,
            codeChallenge: grant.codeChallenge,
            expiresAt: grant.expiresAt,
            consumedAt: null,
            _insertOnly: true,
          })
        ).save();
      });
    });
  }
  async consumeAuthorizationCode(
    input: Parameters<OAuthAuthorizationStorage['consumeAuthorizationCode']>[0],
  ): Promise<OAuthCodeConsumeResult> {
    return this.execute(async () => {
      // Read routing information outside the write transaction to avoid SQLite
      // deferred-read lock upgrades. Every security binding is checked again by CAS.
      const row = await (
        await UsersOAuthAuthorizationCodeCollection.create({ db: this.db })
      ).get(input.id);
      if (
        !row ||
        row.codeHash !== input.codeHash ||
        row.clientId !== input.clientId ||
        row.redirectUri !== input.redirectUri ||
        (row.resource ?? undefined) !== input.resource
      )
        return { status: 'invalid' };
      return withOAuthTransaction(this.db, async (db) => {
        if (!(await this.lockAuthorization(db, row.authorizationId, input.now)))
          return { status: 'invalid' };
        const rows = await UsersOAuthAuthorizationCodeCollection.create({ db });
        if (
          await rows.consume(
            input.id,
            input.codeHash,
            input.clientId,
            input.redirectUri,
            input.resource ?? null,
            input.now,
          )
        )
          return { status: 'consumed', grant: codeGrant(row) };
        const current = await rows.get(input.id);
        return {
          status: current?.consumedAt
            ? 'replayed'
            : current && current.expiresAt <= input.now
              ? 'expired'
              : 'invalid',
        };
      });
    });
  }
  async createRefreshGrant(grant: OAuthRefreshGrant): Promise<void> {
    return this.execute(async () => {
      await withOAuthTransaction(this.db, async (db) => {
        if (
          !(await this.lockAuthorization(
            db,
            authorizationId(grant),
            new Date(),
          ))
        )
          throw new Error('Authorization is revoked.');
        const families = await UsersOAuthRefreshFamilyCollection.create({ db });
        await (
          await families.create({
            id: grant.familyId,
            authorizationId: authorizationId(grant),
            revokedAt: null,
            _insertOnly: true,
          })
        ).save();
        await this.saveRefresh(
          await UsersOAuthRefreshGrantCollection.create({ db }),
          grant,
        );
      });
    });
  }
  async rotateRefreshGrant(
    input: Parameters<OAuthAuthorizationStorage['rotateRefreshGrant']>[0],
  ): Promise<OAuthRefreshRotateResult> {
    return this.execute(async () => {
      const initial = await (
        await UsersOAuthRefreshGrantCollection.create({ db: this.db })
      ).get(input.id);
      if (
        !initial ||
        initial.tokenHash !== input.tokenHash ||
        initial.clientId !== input.clientId ||
        (initial.resource ?? undefined) !== input.resource
      )
        return { status: 'invalid' };
      return withOAuthTransaction(this.db, async (db) => {
        if (
          !(await this.lockAuthorization(
            db,
            initial.authorizationId,
            input.now,
          ))
        )
          return { status: 'revoked' };
        const families = await UsersOAuthRefreshFamilyCollection.create({ db });
        if (!(await families.lock(initial.familyId, input.now)))
          return { status: 'invalid' };
        const family = await families.get(initial.familyId);
        const rows = await UsersOAuthRefreshGrantCollection.create({ db });
        const row = await rows.get(input.id);
        if (!row) return { status: 'invalid' };
        if (family?.revokedAt || row.revokedAt) return { status: 'revoked' };
        if (row.consumedAt) {
          await families.revoke(row.familyId, input.now);
          await rows.revokeFamily(row.familyId, input.now);
          await this.revokeAuthorization(db, row.authorizationId, input.now);
          return { status: 'replayed' };
        }
        if (row.expiresAt <= input.now) return { status: 'expired' };
        if (
          !(await rows.consume(
            input.id,
            input.tokenHash,
            input.clientId,
            input.resource ?? null,
            input.now,
          ))
        )
          return { status: 'invalid' };
        const grant = refreshGrant(row);
        await this.saveRefresh(rows, { ...grant, ...input.replacement });
        return { status: 'rotated', grant };
      });
    });
  }
  /** Persist a narrowed replacement before the SDK exposes it to a caller. */
  async narrowRefreshGrant(input: {
    id: string;
    tokenHash: string;
    scopes: readonly string[];
    claims: OAuthRefreshGrant['claims'];
  }): Promise<void> {
    return this.execute(async () => {
      const initial = await (
        await UsersOAuthRefreshGrantCollection.create({ db: this.db })
      ).get(input.id);
      if (!initial || initial.tokenHash !== input.tokenHash)
        throw new Error('Invalid refresh grant.');
      await withOAuthTransaction(this.db, async (db) => {
        const now = new Date();
        if (!(await this.lockAuthorization(db, initial.authorizationId, now)))
          throw new Error('Authorization is revoked.');
        const families = await UsersOAuthRefreshFamilyCollection.create({ db });
        if (!(await families.lock(initial.familyId, now)))
          throw new Error('Invalid refresh family.');
        const family = await families.get(initial.familyId);
        const row = await (
          await UsersOAuthRefreshGrantCollection.create({ db })
        ).get(input.id);
        if (
          !row ||
          row.tokenHash !== input.tokenHash ||
          family?.revokedAt ||
          row.revokedAt ||
          row.consumedAt ||
          row.expiresAt <= now ||
          input.scopes.some((scope) => !row.getScopes().includes(scope))
        )
          throw new Error('Invalid refresh scope narrowing.');
        await db.query(
          'UPDATE users_oauth_refresh_grants SET scopes = ?, claims = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(input.scopes),
          JSON.stringify(input.claims ?? {}),
          now.toISOString(),
          input.id,
        );
      });
    });
  }

  async revokeRefreshGrant(
    input: Parameters<OAuthAuthorizationStorage['revokeRefreshGrant']>[0],
  ): Promise<void> {
    return this.execute(async () => {
      const row = await (
        await UsersOAuthRefreshGrantCollection.create({ db: this.db })
      ).get(input.id);
      if (!row || row.tokenHash !== input.tokenHash) return;
      await withOAuthTransaction(this.db, async (db) => {
        await this.lockAuthorization(db, row.authorizationId, input.now);
        const families = await UsersOAuthRefreshFamilyCollection.create({ db });
        await families.lock(row.familyId, input.now);
        await families.revoke(row.familyId, input.now);
        await this.revokeAuthorization(db, row.authorizationId, input.now);
        await (
          await UsersOAuthRefreshGrantCollection.create({ db })
        ).revokeFamily(row.familyId, input.now);
      });
    });
  }
  async revokeAccessToken(
    input: Parameters<OAuthAuthorizationStorage['revokeAccessToken']>[0],
  ): Promise<void> {
    return this.execute(async () => {
      await withOAuthTransaction(this.db, async (db) => {
        await db.query(
          'INSERT INTO users_oauth_access_token_revocations (id, slug, jti, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (jti) DO NOTHING',
          randomUUID(),
          randomUUID(),
          input.jti,
          input.expiresAt.toISOString(),
        );
      });
    });
  }

  async isAccessTokenRevoked(jti: string, now: Date): Promise<boolean> {
    return this.execute(async () => {
      const row = await (
        await UsersOAuthAccessTokenRevocationCollection.create({ db: this.db })
      ).findByJti(jti);
      return !!row && row.expiresAt > now;
    });
  }
  private async saveRefresh(
    rows: UsersOAuthRefreshGrantCollection,
    grant: OAuthRefreshGrant,
  ): Promise<void> {
    await (
      await rows.create({
        id: grant.id,
        authorizationId: authorizationId(grant),
        tokenHash: grant.tokenHash,
        familyId: grant.familyId,
        clientId: grant.clientId,
        subject: grant.subject,
        tenantId: grant.tenantId ?? null,
        claims: JSON.stringify(grant.claims ?? {}),
        scopes: JSON.stringify(grant.scopes),
        resource: grant.resource ?? null,
        expiresAt: grant.expiresAt,
        consumedAt: null,
        revokedAt: null,
        _insertOnly: true,
      })
    ).save();
  }
}
