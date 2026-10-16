/**
 * Optional commerce tenant bootstrap.
 *
 * The template does not depend on `@happyvertical/smrt-commerce`. An app that
 * installs it (for example through a cookbook commerce recipe) gets one
 * `ensureCommerceTenant()` call for each tenant it creates: the standard tax
 * codes, its tax settings and the cookbook's tax defaults (`smrt.cookbook.json`).
 * Without commerce this does nothing.
 *
 * `src/routes/setup/+page.server.ts` calls it once the owner claim has
 * created the tenant. Call it from any other place that creates tenants.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';

const COMMERCE_PACKAGE = '@happyvertical/smrt-commerce';

/** The slice of the commerce package entry this module calls. */
export interface CommerceTenantModule {
  ensureCommerceTenant(
    db: DatabaseInterface,
    tenantId: string,
    options?: { cookbook?: { policies: readonly unknown[] } },
  ): Promise<{ tenantId: string }>;
}

export interface CommerceTenantBootstrapOptions {
  /** Project root holding `node_modules` and `smrt.cookbook.json`. */
  readonly root?: string;
  /** Load the commerce entry, or `null` when it is not installed. */
  readonly loadCommerce?: (
    root: string,
  ) => Promise<CommerceTenantModule | null>;
  /** Load the app cookbook's policy rows, or `undefined` without one. */
  readonly loadCookbook?: (
    root: string,
  ) => Promise<{ policies: readonly unknown[] } | undefined>;
}

async function installedCommerce(
  root: string,
): Promise<CommerceTenantModule | null> {
  // Installed means a direct dependency of this app. The specifier stays a
  // variable so the build never requires a package the app did not add.
  if (!existsSync(join(root, 'node_modules', COMMERCE_PACKAGE, 'package.json')))
    return null;
  const specifier: string = COMMERCE_PACKAGE;
  return (await import(/* @vite-ignore */ specifier)) as CommerceTenantModule;
}

async function appCookbook(
  root: string,
): Promise<{ policies: readonly unknown[] } | undefined> {
  const { hasCookbook, loadCookbookApp } = await import(
    '@happyvertical/smrt-svelte/cookbook/server'
  );
  if (!(await hasCookbook(root))) return undefined;
  return (await loadCookbookApp({ root })).cookbook;
}

/**
 * Initialize commerce for a tenant this app just created. Returns `null` when
 * commerce is not installed. Errors propagate; the call is idempotent, so a
 * caller may retry it.
 */
export async function bootstrapCommerceTenant(
  db: DatabaseInterface,
  tenantId: string,
  options: CommerceTenantBootstrapOptions = {},
): Promise<{ tenantId: string } | null> {
  const root = options.root ?? process.cwd();
  const commerce = await (options.loadCommerce ?? installedCommerce)(root);
  if (!commerce) return null;
  const cookbook = await (options.loadCookbook ?? appCookbook)(root);
  return commerce.ensureCommerceTenant(db, tenantId, cookbook ? { cookbook } : {});
}
