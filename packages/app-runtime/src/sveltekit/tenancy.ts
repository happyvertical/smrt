/**
 * Tenant *selection* for SvelteKit requests.
 *
 * Selection and authorization are deliberately separate:
 *
 * - a selector maps a trusted URL shape (by default the leading subdomain) to
 *   an active tenant record and publishes it as `locals.selectedTenant*`;
 * - the signed session (`createSessionHandler({ enterTenantContext: true })`)
 *   authorizes the signed-in user's membership and establishes the request
 *   tenant context.
 *
 * A selected tenant is useful for login and membership-gated switch flows, but
 * it never becomes ambient query authority by itself. The default selector
 * ignores client-provided tenant headers.
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { TenantCollection, TenantStatus } from '@happyvertical/smrt-users';

/** The request fields a tenant selector may read. */
export interface TenantSelectionEvent {
  readonly url: URL;
  readonly request: { readonly headers: Headers };
}

/** URL-derived tenant candidate. Never authorization. */
export interface TenantSelection {
  /** Database ID for an active tenant, or null when none resolves. */
  readonly tenantId: string | null;
  /** URL-derived slug. Informational until membership authorizes a switch. */
  readonly tenantSlug: string | null;
}

/**
 * Replaceable selection extension point. Implementations must preserve the
 * rule that selection alone never establishes authorization context.
 */
export type TenantSelector = (
  event: TenantSelectionEvent,
) => TenantSelection | Promise<TenantSelection>;

const ROOT_LIKE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'admin']);
const NO_SELECTION: TenantSelection = Object.freeze({
  tenantId: null,
  tenantSlug: null,
});

/**
 * Pure URL parser used by the default selector.
 *
 * Set `TENANT_BASE_DOMAIN` (or pass `baseDomain`) in production so
 * multi-label public suffixes are never guessed. Without it, the fallback is
 * intended only for local domains such as `acme.demo.local`.
 */
export function selectTenantSlug(
  url: URL,
  baseDomain: string | undefined = process.env.TENANT_BASE_DOMAIN,
): string | null {
  const hostname = url.hostname.toLowerCase();
  if (
    ROOT_LIKE_HOSTS.has(hostname) ||
    hostname.startsWith('[') ||
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

export interface SubdomainTenantSelectorOptions {
  /** Explicit public base domain. Defaults to `TENANT_BASE_DOMAIN`. */
  readonly baseDomain?: string;
  /** Collection options for the `Tenant` lookup. */
  readonly classOptions: () => SmrtClassOptions;
}

/**
 * Default selector: the leading subdomain names an ACTIVE tenant.
 *
 * A missing `tenants` table (a fresh project before its first migration)
 * yields no selection; the runtime never creates that table.
 */
export function createSubdomainTenantSelector(
  options: SubdomainTenantSelectorOptions,
): TenantSelector {
  return async (event) => {
    const tenantSlug = selectTenantSlug(event.url, options.baseDomain);
    if (!tenantSlug) return NO_SELECTION;
    let tenantId: string | null;
    try {
      const tenants = await TenantCollection.create(options.classOptions());
      const tenant = await tenants.findBySlug(tenantSlug);
      tenantId =
        tenant?.status === TenantStatus.ACTIVE ? (tenant.id ?? null) : null;
    } catch (error) {
      if (!isMissingTenantTable(error)) throw error;
      tenantId = null;
    }
    return { tenantId, tenantSlug };
  };
}

/** Coerce an application selector's result into the published shape. */
export function normalizeTenantSelection(
  selection: TenantSelection | null | undefined,
): TenantSelection {
  const tenantId =
    typeof selection?.tenantId === 'string' && selection.tenantId
      ? selection.tenantId
      : null;
  const tenantSlug =
    typeof selection?.tenantSlug === 'string' && selection.tenantSlug
      ? selection.tenantSlug
      : null;
  return { tenantId, tenantSlug };
}
