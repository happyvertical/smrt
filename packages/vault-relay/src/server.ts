/**
 * Deployment entry: environment configuration, database and object-store
 * wiring, and the two listeners. Quotas, retention, bucket, and database
 * locations are owner inputs with no defaults; a missing value stops startup.
 */
import type { Server } from 'node:http';
import { FeatureResolver } from '@happyvertical/smrt-features';
import { SubscriptionFeatureSource } from '@happyvertical/smrt-subscriptions';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import type { VaultRelayPolicyInput } from './config.js';
import { migrateVaultRelayV1, VaultRelayStore } from './metadata-store.js';
import { createRelayHttpServer } from './node-server.js';
import {
  createS3ObjectStore,
  FilesystemObjectStore,
  type S3ObjectStoreOptions,
  type VaultObjectStore,
} from './object-store.js';
import { jsonLineLogger, VaultRelay } from './relay.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type VaultRelayStorageConfig =
  | { kind: 'filesystem'; path: string }
  | ({ kind: 's3' } & S3ObjectStoreOptions);

export interface VaultRelayServerConfig {
  databaseUrl: string;
  entitlementsDatabaseUrl: string;
  storage: VaultRelayStorageConfig;
  policy: VaultRelayPolicyInput;
  port: number;
  adminPort: number;
  adminToken?: string;
}

/** Thrown for configuration errors; the message names variables, not values. */
export class VaultRelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultRelayConfigError';
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new VaultRelayConfigError(`${name} is required`);
  return value;
}

function integer(env: Env, name: string, fallback?: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    if (fallback === undefined) {
      throw new VaultRelayConfigError(`${name} is required`);
    }
    return fallback;
  }
  if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new VaultRelayConfigError(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

/** Read the server configuration from environment variables. */
export function loadServerConfig(
  env: Env = process.env,
): VaultRelayServerConfig {
  const kind = required(env, 'VAULT_RELAY_STORAGE');
  let storage: VaultRelayStorageConfig;
  if (kind === 'filesystem') {
    storage = { kind, path: required(env, 'VAULT_RELAY_STORAGE_PATH') };
  } else if (kind === 's3') {
    storage = {
      kind,
      bucket: required(env, 'VAULT_RELAY_S3_BUCKET'),
      endpoint: required(env, 'VAULT_RELAY_S3_ENDPOINT'),
      region: required(env, 'VAULT_RELAY_S3_REGION'),
      accessKeyId: required(env, 'VAULT_RELAY_S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'VAULT_RELAY_S3_SECRET_ACCESS_KEY'),
    };
  } else {
    throw new VaultRelayConfigError(
      'VAULT_RELAY_STORAGE must be "filesystem" or "s3"',
    );
  }
  const adminToken = env.VAULT_RELAY_ADMIN_TOKEN?.trim();
  return {
    databaseUrl: required(env, 'VAULT_RELAY_DATABASE_URL'),
    entitlementsDatabaseUrl: required(
      env,
      'VAULT_RELAY_ENTITLEMENTS_DATABASE_URL',
    ),
    storage,
    policy: {
      quota: {
        maxBytes: integer(env, 'VAULT_RELAY_QUOTA_MAX_BYTES'),
        maxSnapshots: integer(env, 'VAULT_RELAY_QUOTA_MAX_SNAPSHOTS'),
      },
      retention: {
        keepLast: integer(env, 'VAULT_RELAY_RETENTION_KEEP_LAST'),
        keepWithinMs:
          integer(env, 'VAULT_RELAY_RETENTION_KEEP_WITHIN_DAYS') * DAY_MS,
      },
      limits: {
        ...(env.VAULT_RELAY_MAX_CHUNK_BYTES
          ? { maxChunkBytes: integer(env, 'VAULT_RELAY_MAX_CHUNK_BYTES') }
          : {}),
        ...(env.VAULT_RELAY_UPLOAD_TTL_SECONDS
          ? {
              uploadTtlMs:
                integer(env, 'VAULT_RELAY_UPLOAD_TTL_SECONDS') * 1000,
            }
          : {}),
        ...(env.VAULT_RELAY_MAX_CLOCK_SKEW_SECONDS
          ? {
              maxClockSkewMs:
                integer(env, 'VAULT_RELAY_MAX_CLOCK_SKEW_SECONDS') * 1000,
            }
          : {}),
        ...(env.VAULT_RELAY_MAX_SEQUENCE_JUMP
          ? {
              maxSequenceJump: integer(env, 'VAULT_RELAY_MAX_SEQUENCE_JUMP'),
            }
          : {}),
      },
    },
    port: integer(env, 'VAULT_RELAY_PORT', 8080),
    adminPort: integer(env, 'VAULT_RELAY_ADMIN_PORT', 8081),
    ...(adminToken ? { adminToken } : {}),
  };
}

/** Open a database from a `postgres://`/`postgresql://` URL or a SQLite path. */
export async function openRelayDatabase(
  url: string,
): Promise<DatabaseInterface> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    return getDatabase({ type: 'postgres', url });
  }
  return getDatabase({ type: 'sqlite', url });
}

async function openObjectStore(
  storage: VaultRelayStorageConfig,
): Promise<VaultObjectStore> {
  if (storage.kind === 'filesystem') {
    return new FilesystemObjectStore(storage.path);
  }
  const { kind: _kind, ...options } = storage;
  return createS3ObjectStore(options);
}

/** Apply the relay schema (the deployment migration step). */
export async function runMigrations(
  config: Pick<VaultRelayServerConfig, 'databaseUrl'>,
): Promise<void> {
  const db = await openRelayDatabase(config.databaseUrl);
  try {
    await migrateVaultRelayV1(db);
  } finally {
    await db.close?.();
  }
}

export interface RunningVaultRelay {
  relay: VaultRelay;
  server: Server;
  adminServer: Server | null;
  close(): Promise<void>;
}

/** Build the relay from configuration and start both listeners. */
export async function startVaultRelayServer(
  config: VaultRelayServerConfig,
): Promise<RunningVaultRelay> {
  const db = await openRelayDatabase(config.databaseUrl);
  const entitlementsDb =
    config.entitlementsDatabaseUrl === config.databaseUrl
      ? db
      : await openRelayDatabase(config.entitlementsDatabaseUrl);
  const resolver = new FeatureResolver({ db: entitlementsDb });
  const relay = new VaultRelay({
    store: new VaultRelayStore(db),
    objects: await openObjectStore(config.storage),
    entitlements: {
      resolver,
      // One grant source per request, so a plan change applies immediately.
      grantSource: () =>
        SubscriptionFeatureSource.create({ db: entitlementsDb }),
    },
    policy: config.policy,
    ...(config.adminToken ? { adminToken: config.adminToken } : {}),
    logger: jsonLineLogger,
  });

  const server = createRelayHttpServer((request) => relay.handle(request));
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  let adminServer: Server | null = null;
  if (config.adminToken) {
    adminServer = createRelayHttpServer((request) =>
      relay.handleAdmin(request),
    );
    await new Promise<void>((resolve) =>
      adminServer?.listen(config.adminPort, resolve),
    );
  }
  const sweep = setInterval(() => {
    relay.sweepExpired().catch((error: unknown) => {
      jsonLineLogger.warn('sweep_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  }, 60_000);
  sweep.unref();
  jsonLineLogger.info('started', {
    port: config.port,
    admin: adminServer !== null,
    storage: config.storage.kind,
  });

  return {
    relay,
    server,
    adminServer,
    async close() {
      clearInterval(sweep);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (adminServer) {
        await new Promise<void>((resolve) =>
          adminServer?.close(() => resolve()),
        );
      }
      if (entitlementsDb !== db) await entitlementsDb.close?.();
      await db.close?.();
    },
  };
}
