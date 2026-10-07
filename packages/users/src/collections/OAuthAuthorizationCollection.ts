/** Atomic durable primitives for the SDK OAuth authorization-server adapter. */
import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  UsersOAuthAccessTokenRevocation,
  UsersOAuthAuthorization,
  UsersOAuthAuthorizationCode,
  UsersOAuthClient,
  UsersOAuthRefreshFamily,
  UsersOAuthRefreshGrant,
} from '../models/OAuthAuthorization.js';

export class UsersOAuthClientCollection extends SmrtCollection<UsersOAuthClient> {
  static readonly _itemClass = UsersOAuthClient;
  findByClientId(clientId: string): Promise<UsersOAuthClient | null> {
    return this.findOne({
      where: { clientId },
    }) as Promise<UsersOAuthClient | null>;
  }
}

export class UsersOAuthAuthorizationCodeCollection extends SmrtCollection<UsersOAuthAuthorizationCode> {
  static readonly _itemClass = UsersOAuthAuthorizationCode;
  async consume(
    id: string,
    codeHash: string,
    clientId: string,
    redirectUri: string,
    resource: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${this.tableName} SET consumed_at = ?, updated_at = ? WHERE id = ? AND code_hash = ? AND client_id = ? AND redirect_uri = ? AND ${resource === null ? 'resource IS NULL' : 'resource = ?'} AND consumed_at IS NULL AND expires_at > ?`,
      now.toISOString(),
      now.toISOString(),
      id,
      codeHash,
      clientId,
      redirectUri,
      ...(resource === null ? [] : [resource]),
      now.toISOString(),
    );
    return result.rowCount === 1;
  }
}

export class UsersOAuthRefreshGrantCollection extends SmrtCollection<UsersOAuthRefreshGrant> {
  static readonly _itemClass = UsersOAuthRefreshGrant;
  async consume(
    id: string,
    tokenHash: string,
    clientId: string,
    resource: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${this.tableName} SET consumed_at = ?, updated_at = ? WHERE id = ? AND token_hash = ? AND client_id = ? AND ${resource === null ? 'resource IS NULL' : 'resource = ?'} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      now.toISOString(),
      now.toISOString(),
      id,
      tokenHash,
      clientId,
      ...(resource === null ? [] : [resource]),
      now.toISOString(),
    );
    return result.rowCount === 1;
  }
  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE ${this.tableName} SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL`,
      now.toISOString(),
      now.toISOString(),
      familyId,
    );
  }
}

export class UsersOAuthAccessTokenRevocationCollection extends SmrtCollection<UsersOAuthAccessTokenRevocation> {
  static readonly _itemClass = UsersOAuthAccessTokenRevocation;
  async findByJti(
    jti: string,
  ): Promise<UsersOAuthAccessTokenRevocation | null> {
    const result = await this.db.query(
      `SELECT id FROM ${this.tableName} WHERE jti = ?`,
      jti,
    );
    return result.rows[0] ? this.get(String(result.rows[0].id)) : null;
  }
}

/** Consent storage is intentionally inaccessible through generated surfaces. */
export class UsersOAuthAuthorizationCollection extends SmrtCollection<UsersOAuthAuthorization> {
  static readonly _itemClass = UsersOAuthAuthorization;
}

/** Family rows exist for the entire lifetime of every descendant refresh token. */
export class UsersOAuthRefreshFamilyCollection extends SmrtCollection<UsersOAuthRefreshFamily> {
  static readonly _itemClass = UsersOAuthRefreshFamily;
  async lock(id: string, now: Date): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${this.tableName} SET updated_at = ? WHERE id = ?`,
      now.toISOString(),
      id,
    );
    return result.rowCount === 1;
  }
  async revoke(id: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE ${this.tableName} SET revoked_at = ?, updated_at = ? WHERE id = ?`,
      now.toISOString(),
      now.toISOString(),
      id,
    );
  }
}
