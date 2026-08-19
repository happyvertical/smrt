/**
 * Issue #2364 (epic #2382, finding A3) — auth lookup columns indexed on the
 * PRODUCTION manifest schema path.
 *
 * `createIsolatedTestDbFromManifest()` with no explicit path auto-detects
 * this package's own freshly-generated manifest and renders tables + indexes
 * through the same structured-schema renderer `smrt db:migrate` uses (#2358)
 * — so this proves the `indexed: true` opt-ins are actually emitted for the
 * real shipped classes, not just the schema generator's synthetic fixtures in
 * `@happyvertical/smrt-core`'s `schema-path-parity.test.ts`.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Row = Record<string, unknown>;

async function rows(db: DatabaseInterface, sql: string): Promise<Row[]> {
  const result = await db.query(sql);
  return Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] }).rows ?? []);
}

async function indexNames(
  db: DatabaseInterface,
  tableName: string,
): Promise<string[]> {
  const result = await rows(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}'`,
  );
  return result.map((row) => String(row.name));
}

describe('auth lookup indexes reach the production manifest schema path (#2364)', () => {
  let baseDb: DatabaseInterface;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ baseDb, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['MagicLinkToken', 'NostrIdentity', 'ApiKey'],
    }));
  });

  afterEach(async () => {
    await cleanup();
  });

  it('indexes `magic_link_tokens.token_hash` — `MagicLinkToken.verify()`s lookup key', async () => {
    const names = await indexNames(baseDb, 'magic_link_tokens');
    expect(names).toContain('magic_link_tokens_token_hash_idx');
  });

  it("indexes `nostr_identities.pubkey` — `NostrIdentity.findByPubkey()`'s lookup key", async () => {
    const names = await indexNames(baseDb, 'nostr_identities');
    expect(names).toContain('nostr_identities_pubkey_idx');
  });

  it("indexes `api_keys.key_hash` — `ApiKey.verify()`'s lookup key", async () => {
    const names = await indexNames(baseDb, 'api_keys');
    expect(names).toContain('api_keys_key_hash_idx');
  });
});
