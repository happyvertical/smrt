/**
 * Express Adapter for smrt-tenancy
 *
 * Provides Express middleware that sets up tenant context for each request.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createExpressMiddleware } from '@happyvertical/smrt-tenancy/adapters';
 *
 * const app = express();
 *
 * app.use(createExpressMiddleware({
 *   resolveTenantId: (req) => req.headers['x-tenant-id'] as string,
 * }));
 * ```
 */

import { type TenantContextData, withTenant } from '../context.js';

/**
 * Express Request interface (minimal to avoid direct dependency)
 */
interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  path: string;
  query: Record<string, unknown>;
  cookies?: Record<string, string>;
}

/**
 * Express Response interface
 */
interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(data: unknown): ExpressResponse;
  send(data: unknown): ExpressResponse;
}

/**
 * Express NextFunction
 */
type ExpressNext = (error?: unknown) => void;

/**
 * Options for Express middleware
 */
export interface ExpressMiddlewareOptions {
  /**
   * Resolve tenant ID from the request
   */
  resolveTenantId: (
    req: ExpressRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Resolve user ID from the request (optional)
   */
  resolveUserId?: (
    req: ExpressRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Resolve permissions (optional)
   */
  resolvePermissions?: (
    req: ExpressRequest,
    tenantId: string,
    userId?: string,
  ) => Promise<Set<string>> | Set<string>;

  /**
   * Check if user is super admin (optional)
   */
  isSuperAdmin?: (
    req: ExpressRequest,
    tenantId: string,
    userId?: string,
  ) => Promise<boolean> | boolean;

  /**
   * Called when no tenant ID could be resolved
   * Return true to continue, false to stop with 400 error.
   */
  onNoTenant?: (
    req: ExpressRequest,
    res: ExpressResponse,
  ) => Promise<boolean> | boolean;

  /**
   * Paths to exclude from tenant context
   */
  excludePaths?: string[];
}

/**
 * Create Express middleware for tenant context
 *
 * @param options - Configuration options
 * @returns Express middleware function
 */
export function createExpressMiddleware(options: ExpressMiddlewareOptions) {
  const {
    resolveTenantId,
    resolveUserId,
    resolvePermissions,
    isSuperAdmin,
    onNoTenant,
    excludePaths = [],
  } = options;

  return async function tenancyMiddleware(
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNext,
  ): Promise<void> {
    try {
      // Check excluded paths
      if (excludePaths.some((pattern) => matchPath(req.path, pattern))) {
        next();
        return;
      }

      // Resolve tenant ID
      const tenantId = await resolveTenantId(req);

      if (!tenantId) {
        if (onNoTenant) {
          const shouldContinue = await onNoTenant(req, res);
          if (shouldContinue) {
            next();
            return;
          }
        } else {
          res.status(400).json({
            error: 'Tenant ID required',
            message:
              'Please provide a tenant ID via header, subdomain, or query parameter.',
          });
          return;
        }
        return;
      }

      // Resolve optional context
      const userId = resolveUserId ? await resolveUserId(req) : undefined;
      const permissions = resolvePermissions
        ? await resolvePermissions(req, tenantId, userId ?? undefined)
        : new Set<string>();
      const superAdminBypass = isSuperAdmin
        ? await isSuperAdmin(req, tenantId, userId ?? undefined)
        : false;

      // Build context
      const context: TenantContextData = {
        tenantId,
        userId: userId ?? undefined,
        permissions,
        superAdminBypass,
      };

      // Attach to request for access in route handlers
      (req as any).tenantContext = context;
      (req as any).tenantId = tenantId;

      // Run in tenant context
      await withTenant(context, async () => {
        next();
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Simple glob pattern matching for paths
 */
function matchPath(path: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\//g, '\\/')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexPattern}$`).test(path);
}
