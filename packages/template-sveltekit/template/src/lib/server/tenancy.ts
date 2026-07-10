/**
 * Tenant selection for SvelteKit requests.
 *
 * Selection and authorization are deliberately separate:
 *
 * - this module maps a trusted URL shape (the leading subdomain) to an active
 *   tenant record;
 * - `createSessionHandler({ enterTenantContext: true })` authorizes the signed-
 *   in user's active membership and establishes the request tenant context.
 *
 * A selected tenant is useful for login and membership-gated switch flows, but
 * it never becomes ambient query authority by itself. In particular, this
 * resolver ignores client-provided tenant headers.
 */

import {
  TenantCollection,
  TenantStatus,
} from '@happyvertical/smrt-users';

import { getSmrtConfig } from './smrt.js';

export interface TenantResolverEvent {
  url: URL;
  request: { headers: Headers };
}

export interface TenantSelection {
  /** Database UUID for an active tenant, or null when none resolves. */
  tenantId: string | null;
  /** URL-derived slug. Informational until membership authorizes a switch. */
  tenantSlug: string | null;
}

const ROOT_LIKE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'admin']);

/**
 * Pure URL parser used by the default resolver.
 *
 * Set `TENANT_BASE_DOMAIN` in production so multi-label public suffixes are
 * never guessed. Without it, the fallback is intended only for local domains
 * such as `acme.demo.local`.
 */
export function selectTenantSlug(
  url: URL,
  baseDomain = process.env.TENANT_BASE_DOMAIN,
): string | null {
  const hostname = url.hostname.toLowerCase();
  if (
    ROOT_LIKE_HOSTS.has(hostname) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  ) {
    return null;
  }

  const normalizedBase = baseDomain
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');

  let candidate: string | undefined;
  if (normalizedBase) {
    if (hostname === normalizedBase) return null;
    const suffix = `.${normalizedBase}`;
    if (!hostname.endsWith(suffix)) return null;
    candidate = hostname.slice(0, -suffix.length).split('.')[0];
  } else {
    const labels = hostname.split('.');
    if (labels.length < 3) return null;
    candidate = labels[0];
  }

  return candidate && !RESERVED_SUBDOMAINS.has(candidate) ? candidate : null;
}

function isMissingTenantTable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (
    code === '42P01' ||
    error.message.includes('relation "tenants" does not exist') ||
    error.message.includes('no such table: tenants')
  );
}

async function findActiveTenantId(slug: string): Promise<string | null> {
  try {
    const tenants = await TenantCollection.create(getSmrtConfig('Tenant'));
    const tenant = await tenants.findBySlug(slug);
    return tenant?.status === TenantStatus.ACTIVE ? (tenant.id ?? null) : null;
  } catch (error) {
    // A fresh project can render before its first `pnpm db:migrate`.
    if (isMissingTenantTable(error)) return null;
    throw error;
  }
}

/**
 * Default selection extension point. Replace this function when your tenant
 * key comes from a path, signed cookie, or trusted gateway assertion. Preserve
 * the rule that selection alone does not establish authorization context.
 */
export async function resolveTenant(
  event: TenantResolverEvent,
): Promise<TenantSelection> {
  const tenantSlug = selectTenantSlug(event.url);
  if (!tenantSlug) return { tenantId: null, tenantSlug: null };

  return {
    tenantId: await findActiveTenantId(tenantSlug),
    tenantSlug,
  };
}
