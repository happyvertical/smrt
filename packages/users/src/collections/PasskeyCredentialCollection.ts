/**
 * Collection for {@link UsersPasskeyCredential} (#3275).
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  knownPasskeyTransports,
  UsersPasskeyCredential,
} from '../models/PasskeyCredential.js';

export interface PasskeyCredentialWrite {
  userId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: readonly string[] | null;
  name: string;
  aaguid: string | null;
  backedUp: boolean;
  deviceType: 'singleDevice' | 'multiDevice' | null;
  createdBy: string;
}

export class UsersPasskeyCredentialCollection extends SmrtCollection<UsersPasskeyCredential> {
  static readonly _itemClass = UsersPasskeyCredential;

  /**
   * The row for an authenticator's credential id. `credentialId` is a
   * sensitive field, which `list()` refuses as a filter, so the id comes from
   * a raw read (as `Session.parentSessionId` does) and the row is then loaded.
   */
  async findByCredentialId(
    credentialId: string,
  ): Promise<UsersPasskeyCredential | null> {
    const result = await this.db.query(
      `SELECT id FROM ${this.tableName} WHERE credential_id = ?`,
      credentialId,
    );
    const id = result.rows?.[0]?.id;
    return typeof id === 'string' ? this.get(id) : null;
  }

  /**
   * Every passkey of one person, oldest first. Read through the collection a
   * service created WITHOUT list bounds: a truncated list would hide passkeys
   * from `excludeCredentials` and from the per-person limit.
   */
  async listByUserId(userId: string): Promise<UsersPasskeyCredential[]> {
    const rows = await this.list({ where: { userId } });
    return rows.sort(
      (a, b) =>
        (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
  }

  /** How many passkeys the person holds (raw count: never list-bounded). */
  async countByUserId(userId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE user_id = ?`,
      userId,
    );
    const total = Number(result.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  /** The passkey `id`, only if it belongs to `userId`. */
  async findOwned(
    id: string,
    userId: string,
  ): Promise<UsersPasskeyCredential | null> {
    const credential = await this.get(id);
    return credential && credential.userId === userId ? credential : null;
  }

  /**
   * Insert a new passkey. Returns null, writing nothing, when the credential
   * id is already registered. One `INSERT … ON CONFLICT DO NOTHING` against
   * the unique `credential_id` decides, so a concurrent duplicate loses too;
   * a constraint error is deliberately never the arbiter (a failed statement
   * on a shared connection can be reported to the wrong caller).
   *
   * Raw, because the base object slugs `name` — a person-chosen label that
   * may be empty after slugging (an emoji or non-Latin name) and collides
   * across people — whereas the id is the one slug that always exists and is
   * unique.
   */
  async insertIfAbsent(
    write: PasskeyCredentialWrite,
  ): Promise<UsersPasskeyCredential | null> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const transports = knownPasskeyTransports(write.transports);
    const { rowCount } = await this.db.query(
      `INSERT INTO ${this.tableName} (
         id, slug, context, user_id, credential_id, public_key, sign_count,
         transports, name, aaguid, backed_up, device_type, last_used_at,
         created_by, created_at, updated_at
       ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (credential_id) DO NOTHING`,
      id,
      id,
      write.userId,
      write.credentialId,
      write.publicKey,
      write.signCount,
      transports.length > 0 ? JSON.stringify(transports) : null,
      write.name,
      write.aaguid,
      write.backedUp,
      write.deviceType,
      write.createdBy,
      now,
      now,
    );
    return rowCount > 0 ? this.get(id) : null;
  }

  /**
   * Record an accepted assertion: advance the counter and `last_used_at` only
   * if the row still exists with the counter that was verified against. One
   * guarded statement, so a passkey removed after the verification — or a
   * concurrent assertion that already advanced the counter — is detected and
   * the caller refuses. Returns false when nothing was updated.
   */
  async recordUseIfCurrent(
    id: string,
    userId: string,
    expectedSignCount: number,
    newSignCount: number,
    backedUp: boolean,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE ${this.tableName}
          SET sign_count = ?, backed_up = ?, last_used_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND sign_count = ?`,
      newSignCount,
      backedUp,
      now.toISOString(),
      now.toISOString(),
      id,
      userId,
      expectedSignCount,
    );
    return rowCount > 0;
  }

  /** Rename a passkey owned by `userId`. Returns false when it is not theirs. */
  async renameOwned(
    id: string,
    userId: string,
    name: string,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE ${this.tableName} SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      name,
      new Date().toISOString(),
      id,
      userId,
    );
    return rowCount > 0;
  }

  /** Delete one passkey owned by `userId`. Returns false when it was already gone. */
  async deleteOwned(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM ${this.tableName} WHERE id = ? AND user_id = ?`,
      id,
      userId,
    );
    return rowCount > 0;
  }

  /** Delete every passkey of one person. Returns how many were removed. */
  async deleteAllForUser(userId: string): Promise<number> {
    const before = await this.countByUserId(userId);
    if (before === 0) return 0;
    await this.db.query(
      `DELETE FROM ${this.tableName} WHERE user_id = ?`,
      userId,
    );
    return before - (await this.countByUserId(userId));
  }
}
