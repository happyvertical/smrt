/**
 * Canonical application identity shared by the web process, operator commands,
 * and generated operational surfaces.
 *
 * Every process that manages the same application must derive the same app ID
 * and the same configuration fingerprint, so these helpers live next to
 * `validateApplicationId()` / `encodeApplicationId()` rather than in copied
 * template scripts.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResolvedApplicationRuntime } from '@happyvertical/smrt-config';
import { encodeApplicationId, validateApplicationId } from './index.js';

export interface ResolveApplicationIdOptions {
  /** Directory containing the application's `package.json`. Defaults to cwd. */
  sourceRoot?: string;
  /** Package name to encode instead of reading `package.json`. */
  packageName?: string;
  /** Explicit, strictly validated app ID (for example `SMRT_APP_ID`). */
  explicitId?: string;
}

/**
 * Resolve one stable application identity.
 *
 * An explicit ID is validated with {@link validateApplicationId}; otherwise
 * the package name is encoded with {@link encodeApplicationId}.
 */
export function resolveApplicationId(
  options: ResolveApplicationIdOptions = {},
): string {
  if (options.explicitId) return validateApplicationId(options.explicitId);
  let packageName = options.packageName;
  if (packageName === undefined) {
    const sourceRoot = options.sourceRoot ?? process.cwd();
    packageName = (
      JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as {
        name?: unknown;
      }
    ).name as string | undefined;
  }
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new Error('package.json must declare a non-empty package name.');
  }
  return encodeApplicationId(packageName);
}

function databaseTargetIdentity(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    const sslMode = target.searchParams.get('sslmode');
    target.username = '';
    target.password = '';
    target.search = '';
    target.hash = '';
    if (sslMode) target.searchParams.set('sslmode', sslMode);
    return target.toString();
  } catch {
    return resolve(value);
  }
}

/**
 * Secret-safe identity used to reject stale managed processes after profile,
 * provider, database-target, or listener configuration changes.
 *
 * Credentials, query strings, and fragments of `DATABASE_URL` are excluded;
 * only `sslmode` survives. The digest is stable for identical inputs so a
 * process manager and the web process can compare it.
 */
export function runtimeConfigurationFingerprint(
  runtime: Pick<ResolvedApplicationRuntime, 'profile' | 'providers'>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        profile: runtime.profile,
        providers: runtime.providers,
        databaseTarget: databaseTargetIdentity(environment.DATABASE_URL),
        host: environment.HOST || null,
        port: environment.PORT || null,
        origin: environment.ORIGIN || null,
        backgroundJobs: environment.SMRT_BACKGROUND_JOBS === 'true',
        readinessModules: {
          authentication: environment.SMRT_AUTH_READINESS_MODULE || null,
          assets: environment.SMRT_ASSETS_READINESS_MODULE || null,
          secrets: environment.SMRT_SECRETS_READINESS_MODULE || null,
        },
        mcpAuthorization: {
          resource: environment.SMRT_MCP_RESOURCE || null,
          issuer: environment.SMRT_MCP_ISSUER || null,
          jwksUri: environment.SMRT_MCP_JWKS_URI || null,
          scopes: environment.SMRT_MCP_SCOPES || null,
        },
      }),
    )
    .digest('hex');
}
