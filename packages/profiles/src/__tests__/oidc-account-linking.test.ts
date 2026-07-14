/**
 * Tests for OIDC account linking functionality
 *
 * Tests the createProfileFromOidc function which handles:
 * - Creating new Profiles from OIDC claims
 * - Reusing an exact issuer/subject identity link
 * - Failing closed on existing email matches that require owner-aware reuse
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  getDatabase,
  syncSchema,
} from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProfileFromOidc } from '../auth/index.js';
import { OidcIdentityCollection } from '../collections/OidcIdentityCollection.js';
import { ProfileCollection } from '../collections/ProfileCollection.js';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection.js';
import { isOidcProvisioningRaceConflict } from '../internal/oidc-provisioning.js';
import { backfillProfileEmailKeys } from '../migrations/backfillProfileEmailKeys.js';
import { OidcIdentity } from '../models/OidcIdentity.js';
import {
  getOidcProvisioningDecisionScenario,
  OIDC_PROVISIONING_DECISION_MATRIX,
  type OidcProvisioningScenario,
  type OidcProvisioningSurfaceExpectation,
} from '../testing/oidcProvisioningDecisionMatrix.js';

const PROFILE_MATRIX_SCENARIOS: readonly OidcProvisioningScenario[] =
  OIDC_PROVISIONING_DECISION_MATRIX.filter(
    (scenario) =>
      scenario.adapters.sqlite.status === 'required' &&
      scenario.expectations.profiles !== undefined,
  );

const OIDC_PROFILES_DUCKDB_TEST_SCHEMA = `
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
`;

describe('OIDC identity generated authority surface', () => {
  it('exposes no generated REST or MCP mutations', () => {
    const registered = ObjectRegistry.getClassInPackage(
      '@happyvertical/smrt-profiles',
      'OidcIdentity',
    );
    expect(registered, 'OidcIdentity must be registered').toBeTruthy();

    const config = (
      registered as {
        config: {
          api?: { include?: string[] };
          mcp?: { include?: string[] };
        };
      }
    ).config;
    for (const surface of [config.api, config.mcp]) {
      expect(surface?.include).toEqual(['list', 'get']);
      expect(surface?.include).not.toContain('create');
      expect(surface?.include).not.toContain('update');
      expect(surface?.include).not.toContain('delete');
    }
  });

  it('keeps the checked-in manifest read-only and includes race arbiters', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../manifest/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as {
      objects: Record<
        string,
        {
          decoratorConfig?: {
            api?: false | { include?: string[] };
            cli?: false | { include?: string[] };
            mcp?: false | { include?: string[] };
          };
          fields?: Record<
            string,
            { _meta?: { unique?: boolean }; readonly?: boolean }
          >;
          filePath?: string;
        }
      >;
    };
    const identity =
      manifest.objects['@happyvertical/smrt-profiles:OidcIdentity'];
    const reservation =
      manifest.objects[
        '@happyvertical/smrt-profiles:OidcProfileEmailReservation'
      ];

    expect(identity?.decoratorConfig?.api).toEqual({
      include: ['list', 'get'],
    });
    expect(identity?.decoratorConfig?.mcp).toEqual({
      include: ['list', 'get'],
    });
    expect(identity?.decoratorConfig?.cli).toEqual({
      include: ['list', 'get'],
    });
    expect(identity?.fields?.identityKey?._meta?.unique).toBe(true);
    expect(identity?.fields?.identityKey?.readonly).toBe(true);
    expect(reservation).toBeDefined();
    expect(reservation?.decoratorConfig?.api).toBe(false);
    expect(reservation?.decoratorConfig?.mcp).toBe(false);
    expect(reservation?.decoratorConfig?.cli).toBe(false);
    expect(reservation?.fields?.profileId?._meta?.unique).toBe(true);
    expect(reservation?.fields?.emailKey?._meta?.unique).toBe(true);
    expect(reservation?.fields?.emailKey?.readonly).toBe(true);
    for (const object of Object.values(manifest.objects)) {
      expect(object.filePath).toBeDefined();
      expect(isAbsolute(object.filePath ?? '')).toBe(false);
      expect(object.filePath).not.toContain('\\');
      expect(object.filePath).toMatch(/^packages\/profiles\/src\//u);
    }
  });

  it('classifies stateful extension patterns deterministically', () => {
    const pattern = /custom_oidc_race/gu;
    const error = new Error('custom_oidc_race');
    const options = { messagePatterns: [pattern] };

    expect(isOidcProvisioningRaceConflict(error, options)).toBe(true);
    expect(isOidcProvisioningRaceConflict(error, options)).toBe(true);
    expect(pattern.lastIndex).toBe(0);
  });
});

describe('OIDC Account Linking', () => {
  let dbUrl: string;

  beforeEach(async () => {
    // Use a temp file database for each test
    dbUrl = join(
      tmpdir(),
      `test-oidc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    // Initialize collections to create tables
    const typeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const personType = await typeCollection.create({
      name: 'Person',
      description: 'Individual person',
    });
    await personType.save();
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await backfillProfileEmailKeys(db);
  });

  describe('executable decision matrix (SQLite)', () => {
    it.each(PROFILE_MATRIX_SCENARIOS)('$id — $title', async (scenario) => {
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      try {
        await runProfileMatrixScenario(db, scenario);
      } finally {
        await db.close?.();
      }
    });
  });

  describe('createProfileFromOidc', () => {
    it('should create a new profile for first-time OIDC login', async () => {
      const { profile, oidcIdentity, created } = await createProfileFromOidc(
        {
          sub: 'google-user-123',
          iss: 'https://accounts.google.com',
          email: 'alice@example.com',
          email_verified: true,
          name: 'Alice Johnson',
        },
        'google',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(created).toBe(true);
      expect(profile.id).toBeDefined();
      expect(profile.email).toBe('alice@example.com');
      expect(profile.name).toBe('Alice Johnson');
      expect(oidcIdentity.subject).toBe('google-user-123');
      expect(oidcIdentity.issuer).toBe('https://accounts.google.com');
    });

    it('accepts the database string shortcut', async () => {
      const stringDbUrl = `file:${join(
        tmpdir(),
        `test-oidc-string-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      )}`;
      await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: stringDbUrl },
      });
      const stringDb = await getDatabase({ type: 'sqlite', url: stringDbUrl });
      await backfillProfileEmailKeys(stringDb);
      const result = await createProfileFromOidc(
        {
          sub: 'string-db-user',
          iss: 'https://accounts.example.com',
          email: 'string-db@example.com',
          email_verified: true,
          name: 'String Database User',
        },
        'example',
        { db: stringDbUrl },
      );

      expect(result.created).toBe(true);
      expect(result.profile.email).toBe('string-db@example.com');
    });

    it('should return existing profile for same OIDC identity', async () => {
      const claims = {
        sub: 'google-user-456',
        iss: 'https://accounts.google.com',
        email: 'bob@example.com',
        email_verified: true,
        name: 'Bob Smith',
      };

      // First login
      const first = await createProfileFromOidc(claims, 'google', {
        db: { type: 'sqlite', url: dbUrl },
      });
      expect(first.created).toBe(true);

      // Second login with same identity
      const second = await createProfileFromOidc(claims, 'google', {
        db: { type: 'sqlite', url: dbUrl },
      });
      expect(second.created).toBe(false);
      expect(second.profile.id).toBe(first.profile.id);
      expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    });

    it('keeps deprecated findOrCreate compatible only for an exact safe identity', async () => {
      const claims = {
        sub: 'legacy-exact-subject',
        iss: 'https://legacy.example.com',
        email: 'legacy-exact@example.com',
        email_verified: true,
      };
      const created = await createProfileFromOidc(claims, 'legacy', {
        db: { type: 'sqlite', url: dbUrl },
      });

      const identity = await OidcIdentity.findOrCreate(created.profile, {
        email: claims.email,
        issuer: claims.iss,
        provider: 'legacy',
        subject: claims.sub,
      });

      expect(identity.id).toBe(created.oidcIdentity.id);
      const identities = await (
        await OidcIdentityCollection.create({
          persistence: { type: 'sqlite', url: dbUrl },
        })
      ).list({});
      expect(identities).toHaveLength(1);
    });

    it('preserves an exact legacy link to a tenant-scoped non-Person Profile', async () => {
      const db = { type: 'sqlite' as const, url: dbUrl };
      const claims = {
        sub: 'legacy-organization-subject',
        iss: 'https://legacy.example.com',
        email: 'legacy-organization@example.com',
        email_verified: true,
      };
      const created = await createProfileFromOidc(claims, 'legacy', { db });
      const database = await getDatabase(db);
      try {
        await database.query(
          `UPDATE profiles
             SET tenant_id = ?, _meta_type = ?
           WHERE id = ?`,
          'legacy-tenant',
          '@happyvertical/smrt-profiles:Organization',
          created.profile.id,
        );
      } finally {
        await database.close?.();
      }

      const exactReuse = await createProfileFromOidc(
        {
          ...claims,
          email: 'legacy-organization-updated@example.com',
        },
        'legacy',
        { db },
      );

      expect(exactReuse.created).toBe(false);
      expect(exactReuse.profile.id).toBe(created.profile.id);
      expect(exactReuse.oidcIdentity.id).toBe(created.oidcIdentity.id);
      expect(exactReuse.profile.tenantId).toBe('legacy-tenant');
      expect(exactReuse.profile._meta_type).toBe(
        '@happyvertical/smrt-profiles:Organization',
      );

      const reused = await OidcIdentity.findOrCreate(exactReuse.profile, {
        email: 'legacy-organization-updated@example.com',
        issuer: claims.iss,
        provider: 'legacy',
        subject: claims.sub,
      });

      expect(reused.id).toBe(created.oidcIdentity.id);
      expect(reused.email).toBe('legacy-organization-updated@example.com');
      expect(reused.identityKey).toBe(
        '["https://legacy.example.com","legacy-organization-subject"]',
      );
    });

    it('deprecated findOrCreate refuses to create a new authentication link', async () => {
      const created = await createProfileFromOidc(
        {
          sub: 'legacy-removed-subject',
          iss: 'https://legacy.example.com',
          email: 'legacy-removed@example.com',
          email_verified: true,
        },
        'legacy',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      await created.oidcIdentity.delete();

      await expect(
        OidcIdentity.findOrCreate(
          created.profile,
          {
            email: created.profile.email,
            issuer: 'https://legacy.example.com',
            provider: 'legacy',
            subject: 'legacy-new-subject',
          },
          { db: { type: 'sqlite', url: dbUrl } },
        ),
      ).rejects.toThrow('no longer creates authentication links');

      const identities = await (
        await OidcIdentityCollection.create({
          persistence: { type: 'sqlite', url: dbUrl },
        })
      ).list({});
      expect(identities).toHaveLength(0);
    });

    it('preserves the exact opaque issuer and subject claims', async () => {
      const first = await createProfileFromOidc(
        {
          sub: 'opaque-subject',
          iss: 'https://issuer.example.com',
          email: 'opaque-first@example.com',
          email_verified: true,
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      const second = await createProfileFromOidc(
        {
          sub: ' opaque-subject',
          iss: 'https://issuer.example.com',
          email: 'opaque-second@example.com',
          email_verified: true,
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(second.profile.id).not.toBe(first.profile.id);
      expect(second.oidcIdentity.id).not.toBe(first.oidcIdentity.id);
      expect(second.oidcIdentity.subject).toBe(' opaque-subject');
      expect(second.oidcIdentity.identityKey).toBe(
        '["https://issuer.example.com"," opaque-subject"]',
      );
    });

    it('fails closed before Profile-only cross-provider email linking', async () => {
      const email = 'carol@example.com';

      // First login with Google
      const googleLogin = await createProfileFromOidc(
        {
          sub: 'google-carol-123',
          iss: 'https://accounts.google.com',
          email,
          email_verified: true,
          name: 'Carol Davis',
        },
        'google',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      expect(googleLogin.created).toBe(true);

      // Second login with GitHub (same email)
      await expect(
        createProfileFromOidc(
          {
            sub: '98765',
            iss: 'https://github.com',
            email,
            email_verified: true,
            name: 'Carol Davis',
          },
          'github',
          { db: { type: 'sqlite', url: dbUrl } },
        ),
      ).rejects.toThrow('cannot prove that Profile is unowned');

      expect(googleLogin.oidcIdentity.issuer).toBe(
        'https://accounts.google.com',
      );

      // The original exact identity remains unchanged and no new link is
      // persisted. Owner-aware linking belongs to smrt-users.
      const identityCollection = await OidcIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const identities = await identityCollection.list({});
      expect(identities).toHaveLength(1);
      expect(identities[0].profileId).toBe(googleLogin.profile.id);
    });

    it('should NOT link accounts when email is not verified', async () => {
      const email = 'dave@example.com';

      // First login with verified email
      await createProfileFromOidc(
        {
          sub: 'provider1-dave',
          iss: 'https://provider1.com',
          email,
          email_verified: true,
          name: 'Dave Wilson',
        },
        'provider1',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      // Second login with UNVERIFIED email (should NOT link)
      await expect(
        createProfileFromOidc(
          {
            sub: 'provider2-dave',
            iss: 'https://provider2.com',
            email,
            email_verified: false,
            name: 'Dave Wilson',
          },
          'provider2',
          { db: { type: 'sqlite', url: dbUrl } },
        ),
      ).rejects.toThrow('not verified');
    });

    it('should NOT link accounts when email_verified is undefined', async () => {
      const email = 'eve@example.com';

      // First login with verified email
      await createProfileFromOidc(
        {
          sub: 'provider1-eve',
          iss: 'https://provider1.com',
          email,
          email_verified: true,
          name: 'Eve Brown',
        },
        'provider1',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Second login without email_verified claim
      await expect(
        createProfileFromOidc(
          {
            sub: 'provider2-eve',
            iss: 'https://provider2.com',
            email,
            name: 'Eve Brown',
          },
          'provider2',
          { db: { type: 'sqlite', url: dbUrl } },
        ),
      ).rejects.toThrow('not verified');
    });

    it('should create separate profiles for different emails', async () => {
      const login1 = await createProfileFromOidc(
        {
          sub: 'user-1',
          iss: 'https://auth.example.com',
          email: 'user1@example.com',
          email_verified: true,
          name: 'User One',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      const login2 = await createProfileFromOidc(
        {
          sub: 'user-2',
          iss: 'https://auth.example.com',
          email: 'user2@example.com',
          email_verified: true,
          name: 'User Two',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(login1.created).toBe(true);
      expect(login2.created).toBe(true);
      expect(login1.profile.id).not.toBe(login2.profile.id);
    });

    it('should handle login without email', async () => {
      const { profile, created } = await createProfileFromOidc(
        {
          sub: 'nostr-pubkey-abc123',
          iss: 'https://nostr.example.com',
          // No email
          name: 'Anon User',
        },
        'nostr',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(created).toBe(true);
      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('Anon User');
    });

    it('converges concurrent first login on one Profile and identity', async () => {
      const concurrentClaims = {
        sub: 'concurrent-profile-subject',
        iss: 'https://auth.example.com',
        email: 'concurrent-profile@example.com',
        email_verified: true,
        name: 'Concurrent Profile',
      };

      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      try {
        const [first, second] = await Promise.all([
          createProfileFromOidc(concurrentClaims, 'example', { db }),
          createProfileFromOidc(concurrentClaims, 'example', { db }),
        ]);

        expect(second.profile.id).toBe(first.profile.id);
        expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
      } finally {
        await db.close?.();
      }
    });

    it('preserves unrelated same-name Profiles on one SQLite root handle', async () => {
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      const sharedClaims = {
        iss: 'https://auth.example.com',
        email_verified: true,
        name: 'Shared Display Name',
      };

      try {
        const [first, second] = await Promise.all([
          createProfileFromOidc(
            {
              ...sharedClaims,
              email: 'same-name-first@example.com',
              sub: 'same-name-first',
            },
            'example',
            { db },
          ),
          createProfileFromOidc(
            {
              ...sharedClaims,
              email: 'same-name-second@example.com',
              sub: 'same-name-second',
            },
            'example',
            { db },
          ),
        ]);

        expect(second.profile.id).not.toBe(first.profile.id);
        expect(second.oidcIdentity.id).not.toBe(first.oidcIdentity.id);
        await expect(countRows(db, 'profiles')).resolves.toBe(2);
        await expect(countRows(db, 'oidc_identities')).resolves.toBe(2);
      } finally {
        await db.close?.();
      }
    });

    it('converges first login across independent SQLite connections', async () => {
      const firstDb = await getDatabase({
        type: 'sqlite',
        url: dbUrl,
        dbid: `oidc-profile-sqlite-first-${randomUUID()}`,
      });
      const secondDb = await getDatabase({
        type: 'sqlite',
        url: dbUrl,
        dbid: `oidc-profile-sqlite-second-${randomUUID()}`,
      });
      let activeLookups = 0;
      let maxActiveLookups = 0;
      const observeLookup = async () => {
        activeLookups += 1;
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        activeLookups -= 1;
      };
      const concurrentClaims = {
        sub: 'independent-profile-subject',
        iss: 'https://auth.example.com',
        email: 'independent-profile@example.com',
        email_verified: true,
        name: 'Independent Profile',
      };

      try {
        const [first, second] = await Promise.all([
          createProfileFromOidc(concurrentClaims, 'example', {
            db: withIdentityLookupObserver(firstDb, observeLookup),
          }),
          createProfileFromOidc(concurrentClaims, 'example', {
            db: withIdentityLookupObserver(secondDb, observeLookup),
          }),
        ]);

        expect(maxActiveLookups).toBe(1);
        expect(second.profile.id).toBe(first.profile.id);
        expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
        await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
        await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
        await expect(
          countRows(firstDb, 'oidc_profile_email_reservations'),
        ).resolves.toBe(1);
      } finally {
        await Promise.all([firstDb.close?.(), secondDb.close?.()]);
      }
    });

    it('serializes one issuer/subject with different emails across independent DuckDB handles', async () => {
      const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
      await ProfileTypeCollection.create({ db });
      await backfillProfileEmailKeys(db);
      let activeLookups = 0;
      let maxActiveLookups = 0;
      const observeLookup = async () => {
        activeLookups += 1;
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        activeLookups -= 1;
      };
      const firstDb = withIdentityLookupObserver(db, observeLookup);
      const secondDb = withIdentityLookupObserver(db, observeLookup);
      const sharedClaims = {
        sub: 'duckdb-shared-profile-subject',
        iss: 'https://auth.example.com',
        email_verified: true,
        name: 'DuckDB Shared Profile',
      };

      try {
        const [first, second] = await Promise.all([
          createProfileFromOidc(
            { ...sharedClaims, email: 'duckdb-profile-first@example.com' },
            'example',
            { db: firstDb },
          ),
          createProfileFromOidc(
            { ...sharedClaims, email: 'duckdb-profile-second@example.com' },
            'example',
            { db: secondDb },
          ),
        ]);

        expect(maxActiveLookups).toBe(1);
        expect(second.profile.id).toBe(first.profile.id);
        expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
        await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
        await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
      } finally {
        await db.close?.();
      }
    });

    it('fails closed on an ambiguous callback-only root adapter', async () => {
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      const callbackOnlyRoot = new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'beginTransaction') return undefined;
          if (property === 'query') {
            return async (sql: string, ...params: unknown[]) => {
              if (/^SAVEPOINT\b/iu.test(sql)) {
                throw new Error(
                  'SAVEPOINT can only be used in transaction blocks',
                );
              }
              return target.query(sql, ...params);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        await expect(
          createProfileFromOidc(
            {
              sub: 'callback-only-profile-subject',
              iss: 'https://auth.example.com',
              email: 'callback-only-profile@example.com',
              email_verified: true,
            },
            'example',
            { db: callbackOnlyRoot },
          ),
        ).rejects.toThrow('root database');
      } finally {
        await db.close?.();
      }
    });

    it.each([
      getOidcProvisioningDecisionScenario('duckdb-caller-owned-transaction'),
    ])('$id — $title (Profiles manual transaction)', async (scenario) => {
      const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
      await syncSchema({ db, schema: OIDC_PROFILES_DUCKDB_TEST_SCHEMA });
      const before = await profileMatrixRowCounts(db);
      if (!db.beginTransaction) {
        throw new Error('Expected DuckDB manual transaction support.');
      }
      const tx = await db.beginTransaction();
      try {
        await expectProfileMatrixRejection(
          createProfileFromOidc(
            {
              sub: 'duckdb-manual-profile',
              iss: 'https://auth.example.com',
              email: 'duckdb-manual-profile@example.com',
              email_verified: true,
            },
            'example',
            { db: tx },
          ),
          scenario.expectations.profiles?.publicError ?? null,
        );

        await expectProfileMatrixRowDelta(
          tx,
          before,
          scenario.expectations.profiles,
        );

        expect(tx.isActive()).toBe(true);
        await tx.query('CREATE TABLE profile_outer_probe (id INTEGER)');
        await tx.query('INSERT INTO profile_outer_probe VALUES (1)');
        const result = await tx.query(
          'SELECT count(*) AS count FROM profile_outer_probe',
        );
        expect(Number(result.rows[0]?.count)).toBe(1);
      } finally {
        if (tx.isActive()) await tx.rollback();
        await db.close?.();
      }
    });

    it.each([
      getOidcProvisioningDecisionScenario('duckdb-caller-owned-transaction'),
    ])('$id — $title (Profiles callback transaction)', async (scenario) => {
      const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
      await syncSchema({ db, schema: OIDC_PROFILES_DUCKDB_TEST_SCHEMA });
      const before = await profileMatrixRowCounts(db);
      if (!db.transaction) {
        throw new Error('Expected DuckDB callback transaction support.');
      }
      try {
        await db.transaction(async (tx) => {
          await expectProfileMatrixRejection(
            createProfileFromOidc(
              {
                sub: 'duckdb-callback-profile',
                iss: 'https://auth.example.com',
                email: 'duckdb-callback-profile@example.com',
                email_verified: true,
              },
              'example',
              { db: tx },
            ),
            scenario.expectations.profiles?.publicError ?? null,
          );

          await expectProfileMatrixRowDelta(
            tx,
            before,
            scenario.expectations.profiles,
          );

          await tx.query('CREATE TABLE profile_callback_probe (id INTEGER)');
          await tx.query('INSERT INTO profile_callback_probe VALUES (1)');
          const result = await tx.query(
            'SELECT count(*) AS count FROM profile_callback_probe',
          );
          expect(Number(result.rows[0]?.count)).toBe(1);
        });
      } finally {
        await db.close?.();
      }
    });

    it('does not retry an unrelated unique constraint', async () => {
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      let transactionAttempts = 0;
      const failingDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async <T>(
              callback: (tx: typeof db) => Promise<T>,
            ): Promise<T> => {
              transactionAttempts += 1;
              if (!target.transaction) {
                throw new Error('Expected a transaction-capable database.');
              }
              return target.transaction(async (tx) =>
                callback(
                  new Proxy(tx, {
                    get(txTarget, txProperty, txReceiver) {
                      if (txProperty === 'query') {
                        return async (sql: string, ...params: unknown[]) => {
                          if (/oidc_identities/iu.test(sql)) {
                            throw new Error(
                              'UNIQUE constraint failed: unrelated.slug',
                            );
                          }
                          return txTarget.query(sql, ...params);
                        };
                      }
                      const value = Reflect.get(
                        txTarget,
                        txProperty,
                        txReceiver,
                      );
                      return typeof value === 'function'
                        ? value.bind(txTarget)
                        : value;
                    },
                  }),
                ),
              );
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        await expect(
          createProfileFromOidc(
            {
              sub: 'unrelated-constraint-subject',
              iss: 'https://auth.example.com',
              email: 'unrelated-constraint@example.com',
              email_verified: true,
            },
            'example',
            { db: failingDb },
          ),
        ).rejects.toThrow('unrelated.slug');
        expect(transactionAttempts).toBe(1);
      } finally {
        await db.close?.();
      }
    });
  });

  describe('ProfileCollection.findByEmail', () => {
    it('should find profile by email case-insensitively', async () => {
      const collection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      // Create a profile with lowercase email
      await createProfileFromOidc(
        {
          sub: 'user-123',
          iss: 'https://auth.example.com',
          email: 'test@example.com',
          email_verified: true,
          name: 'Test User',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Find by uppercase email
      const found = await collection.findByEmail('TEST@EXAMPLE.COM');
      expect(found).not.toBeNull();
      expect(found?.email).toBe('test@example.com');
    });

    it('keeps general email lookup compatible before the identity backfill', async () => {
      const created = await createProfileFromOidc(
        {
          sub: 'legacy-find-user',
          iss: 'https://auth.example.com',
          email: 'legacy-find@example.com',
          email_verified: true,
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      await db.query(
        'UPDATE profiles SET email_key = NULL WHERE id = ?',
        created.profile.id,
      );
      await db.query(
        `DELETE FROM _smrt_backfills
         WHERE name = '@happyvertical/smrt-profiles:profile-email-keys:v1'`,
      );
      const collection = await ProfileCollection.create({ db });

      await expect(
        collection.findByEmail('legacy-find@example.com'),
      ).resolves.toMatchObject({ id: created.profile.id });
      await expect(backfillProfileEmailKeys(db)).resolves.toEqual({
        updated: 1,
      });
      await expect(
        collection.findByEmail('legacy-find@example.com'),
      ).resolves.toMatchObject({ id: created.profile.id });
    });

    it('should return null for non-existent email', async () => {
      const collection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      const found = await collection.findByEmail('nonexistent@example.com');
      expect(found).toBeNull();
    });
  });
});

interface ProfileMatrixResult {
  created: boolean;
  profile: { id?: string };
  oidcIdentity: { id?: string };
}

async function runProfileMatrixScenario(
  db: DatabaseInterface,
  scenario: OidcProvisioningScenario,
): Promise<void> {
  const expected = scenario.expectations.profiles;
  if (!expected) {
    throw new Error(`Missing Profiles expectation for ${scenario.id}`);
  }

  const email = 'matrix@example.com';
  const subject = `matrix-${scenario.id}`;
  let identityProfileId: string | undefined;
  let identityId: string | undefined;
  let emailProfileId: string | undefined;

  if (scenario.identity === 'exact_missing_profile') {
    identityId = await seedProfileMatrixIdentity(
      db,
      randomUUID(),
      email,
      subject,
      false,
    );
  } else if (scenario.identity !== 'none') {
    const identityEmail =
      scenario.email === 'different_global_person'
        ? 'linked-matrix@example.com'
        : email;
    identityProfileId = await seedProfileMatrixProfile(db, {
      email: identityEmail,
      metaType:
        scenario.identity === 'exact_legacy_non_person_profile'
          ? '@happyvertical/smrt-profiles:Organization'
          : undefined,
      tenantId:
        scenario.identity === 'exact_legacy_tenant_profile'
          ? randomUUID()
          : undefined,
    });
    const legacyIdentity =
      scenario.identity.startsWith('exact_legacy_') ||
      scenario.identity === 'exact_ambiguous_legacy_links';
    identityId = await seedProfileMatrixIdentity(
      db,
      identityProfileId,
      identityEmail,
      subject,
      legacyIdentity,
    );
    if (scenario.identity === 'exact_ambiguous_legacy_links') {
      const duplicateProfileId = await seedProfileMatrixProfile(db, {
        email: identityEmail,
      });
      await seedProfileMatrixIdentity(
        db,
        duplicateProfileId,
        identityEmail,
        subject,
        true,
      );
    }
    if (scenario.email === 'different_global_person') {
      emailProfileId = await seedProfileMatrixProfile(db, { email });
    }
  } else if (
    scenario.email === 'one_unowned_global_person' ||
    scenario.email === 'tenant_scoped_collision' ||
    scenario.email === 'non_person_collision' ||
    scenario.email === 'duplicate_normalized_profiles'
  ) {
    emailProfileId = await seedProfileMatrixProfile(db, {
      email,
      metaType:
        scenario.email === 'non_person_collision'
          ? '@happyvertical/smrt-profiles:Organization'
          : undefined,
      tenantId:
        scenario.email === 'tenant_scoped_collision' ? randomUUID() : undefined,
    });
    if (scenario.email === 'duplicate_normalized_profiles') {
      await seedProfileMatrixProfile(db, { email: ' MATRIX@example.com ' });
    }
  }

  if (expected.readiness === 'none') {
    await db.query(
      `DELETE FROM _smrt_backfills
       WHERE name = ?`,
      '@happyvertical/smrt-profiles:profile-email-keys:v1',
    );
  }

  const before = await profileMatrixRowCounts(db);
  const identityBindingsBefore = await profileMatrixIdentityBindings(
    db,
    subject,
  );
  const claims = {
    email: scenario.email === 'missing' ? undefined : email,
    email_verified:
      scenario.verification === 'claim_missing'
        ? undefined
        : scenario.verification === 'verified',
    iss: 'https://issuer.example.com',
    name: 'Matrix Profile',
    sub: subject,
  };
  const invoke = (database: DatabaseInterface = db) =>
    createProfileFromOidc(claims, 'matrix', { db: database });
  const values: ProfileMatrixResult[] = [];
  const errors: unknown[] = [];

  if (scenario.execution === 'concurrent_winner_and_observer') {
    collectProfileMatrixSettled(
      await Promise.allSettled([invoke(), invoke()]),
      values,
      errors,
    );
  } else if (scenario.execution === 'caller_owned_transaction') {
    const transaction = db.transaction;
    if (!transaction) throw new Error('SQLite matrix requires transaction().');
    await collectProfileMatrixPromise(
      transaction.call(db, (tx) => invoke(tx)),
      values,
      errors,
    );
  } else {
    await collectProfileMatrixPromise(invoke(), values, errors);
  }

  expectProfileMatrixOutcome(expected, values, errors);
  expectProfileMatrixCreatedResult(expected, values);
  expect(expected.resolverCalls).toBe(0);
  const profileIds = values.map((value) => value.profile.id);
  if (expected.selectedProfile === 'concurrent_winner') {
    expect(new Set(profileIds).size).toBe(1);
  } else if (expected.selectedProfile === 'exact_identity_profile') {
    expect(profileIds.every((id) => id === identityProfileId)).toBe(true);
    expect(values.every((value) => value.oidcIdentity.id === identityId)).toBe(
      true,
    );
  } else if (expected.selectedProfile === 'new_profile') {
    expect(profileIds.every((id) => typeof id === 'string')).toBe(true);
    expect(profileIds).not.toContain(emailProfileId);
  }

  await expectProfileMatrixRowDelta(db, before, expected);
  if (scenario.identity !== 'none' && !expected.rebindAllowed) {
    await expect(profileMatrixIdentityBindings(db, subject)).resolves.toEqual(
      identityBindingsBefore,
    );
  }
}

async function seedProfileMatrixProfile(
  db: DatabaseInterface,
  options: { email: string; metaType?: string; tenantId?: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO profiles
      (id, slug, context, _meta_type, tenant_id, email, email_key, name)
     VALUES (?, ?, '', ?, ?, ?, ?, 'Matrix Profile')`,
    id,
    `matrix-${id}`,
    options.metaType ?? '@happyvertical/smrt-profiles:Person',
    options.tenantId ?? null,
    options.email,
    options.email.trim().toLowerCase(),
  );
  return id;
}

async function seedProfileMatrixIdentity(
  db: DatabaseInterface,
  profileId: string,
  email: string,
  subject: string,
  legacy: boolean,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO oidc_identities
      (id, slug, context, profile_id, provider, issuer, subject, identity_key, email)
     VALUES (?, ?, '', ?, 'matrix', 'https://issuer.example.com', ?, ?, ?)`,
    id,
    `matrix-${id}`,
    profileId,
    subject,
    legacy ? null : JSON.stringify(['https://issuer.example.com', subject]),
    email,
  );
  return id;
}

async function profileMatrixIdentityBindings(
  db: DatabaseInterface,
  subject: string,
): Promise<Array<{ id: string; profileId: string }>> {
  const result = await db.query(
    `SELECT id, profile_id
     FROM oidc_identities
     WHERE issuer = ? AND subject = ?
     ORDER BY id`,
    'https://issuer.example.com',
    subject,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    profileId: String(row.profile_id),
  }));
}

async function profileMatrixRowCounts(
  db: DatabaseInterface,
): Promise<{ profile: number; oidcIdentity: number }> {
  const [profile, oidcIdentity] = await Promise.all([
    countRows(db, 'profiles'),
    countRows(db, 'oidc_identities'),
  ]);
  return { profile, oidcIdentity };
}

async function expectProfileMatrixRowDelta(
  db: DatabaseInterface,
  before: { profile: number; oidcIdentity: number },
  expected: OidcProvisioningSurfaceExpectation | undefined,
): Promise<void> {
  if (!expected) throw new Error('Missing Profiles matrix expectation.');
  const after = await profileMatrixRowCounts(db);
  expect({
    profile: after.profile - before.profile,
    oidcIdentity: after.oidcIdentity - before.oidcIdentity,
    user: 0,
    session: 0,
  }).toEqual(expected.createdRows);
}

async function collectProfileMatrixPromise(
  promise: Promise<ProfileMatrixResult>,
  values: ProfileMatrixResult[],
  errors: unknown[],
): Promise<void> {
  try {
    values.push(await promise);
  } catch (error) {
    errors.push(error);
  }
}

function collectProfileMatrixSettled(
  results: PromiseSettledResult<ProfileMatrixResult>[],
  values: ProfileMatrixResult[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else errors.push(result.reason);
  }
}

function expectProfileMatrixOutcome(
  expected: OidcProvisioningSurfaceExpectation,
  values: ProfileMatrixResult[],
  errors: unknown[],
): void {
  if (expected.outcome === 'success') {
    expect(values.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  } else {
    expect(values).toHaveLength(0);
    expect(errors).toHaveLength(1);
  }
  for (const error of errors) {
    expectProfileMatrixPublicError(error, expected.publicError);
  }
}

function expectProfileMatrixCreatedResult(
  expected: OidcProvisioningSurfaceExpectation,
  values: ProfileMatrixResult[],
): void {
  const created = values.map((value) => value.created);
  if (expected.resultCreated === 'none') expect(created).toHaveLength(0);
  else if (expected.resultCreated === 'created') {
    expect(created.every(Boolean)).toBe(true);
  } else if (expected.resultCreated === 'reused') {
    expect(created.every((value) => !value)).toBe(true);
  } else {
    expect(created).toContain(true);
    expect(created).toContain(false);
  }
}

function expectProfileMatrixPublicError(
  error: unknown,
  publicError: OidcProvisioningSurfaceExpectation['publicError'],
): void {
  expect(publicError).not.toBeNull();
  if (!publicError) return;
  if ('code' in publicError) {
    expect(error).toEqual(expect.objectContaining({ code: publicError.code }));
  } else if ('name' in publicError) {
    expect(error).toEqual(expect.objectContaining({ name: publicError.name }));
  } else {
    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(publicError.messageIncludes),
      }),
    );
  }
}

async function expectProfileMatrixRejection(
  promise: Promise<unknown>,
  publicError: OidcProvisioningSurfaceExpectation['publicError'],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expectProfileMatrixPublicError(error, publicError);
    return;
  }
  throw new Error('Expected OIDC Profile provisioning to reject.');
}

function withIdentityLookupObserver(
  db: DatabaseInterface,
  observe: () => Promise<void>,
): DatabaseInterface {
  const wrap = (database: DatabaseInterface): DatabaseInterface =>
    new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'query') {
          return async (sql: string, ...params: unknown[]) => {
            const result = await target.query(sql, ...params);
            if (/from\s+["`]?oidc_identities["`]?/iu.test(sql)) {
              await observe();
            }
            return result;
          };
        }
        if (property === 'transaction') {
          const transaction = target.transaction;
          if (!transaction) return undefined;
          return async <T>(
            callback: (tx: DatabaseInterface) => Promise<T>,
          ): Promise<T> => transaction.call(target, (tx) => callback(wrap(tx)));
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return wrap(db);
}

async function countRows(
  db: DatabaseInterface,
  table: 'oidc_identities' | 'oidc_profile_email_reservations' | 'profiles',
): Promise<number> {
  const result = await db.query(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}
