import type { TenantCollection } from '@happyvertical/smrt-users';
import type { Course } from './catalog.js';
import type { CourseCollection } from './collections.js';

/** The application-owned decision that permits a catalog view for one tenant. */
export type TenantCatalogReadScope =
  TenantCollection['withTenantCatalogReadScope'];
export type CatalogActorContext = Parameters<
  Parameters<TenantCatalogReadScope>[0]['authorize']
>[0];

export type CatalogAuthorizer = (
  request: Omit<CatalogActorContext, 'mode'> & {
    action: 'education.catalog.read' | 'education.catalog.read-private';
  },
) => boolean | Promise<boolean>;

export interface CatalogReadRequest {
  tenantId: string;
  actorUserId: string;
  includePrivate?: boolean;
  options?: Omit<Parameters<CourseCollection['list']>[0], 'where'>;
}

export class CatalogAuthorizationError extends Error {
  constructor() {
    super('Education catalog access is not authorized.');
    this.name = 'CatalogAuthorizationError';
  }
}

/**
 * The only package-level family → group → global catalog read boundary.
 * Generated surfaces are closed; callers must supply both an application
 * authorization decision and the narrowly-scoped tenancy capability.
 */
export class CatalogService {
  constructor(
    private readonly courses: CourseCollection,
    private readonly tenants: Pick<
      TenantCollection,
      'withTenantCatalogReadScope'
    >,
    private readonly authorize: CatalogAuthorizer,
  ) {}
  async findVisible(request: CatalogReadRequest): Promise<Course[]> {
    const {
      tenantId,
      actorUserId,
      includePrivate = false,
      options = {},
    } = request;
    if (!tenantId.trim() || !actorUserId.trim())
      throw new CatalogAuthorizationError();
    const actor = {
      actorTenantId: tenantId,
      actorUserId,
      rootTenantId: tenantId,
    };
    const allowed = await this.authorize({
      ...actor,
      action: 'education.catalog.read',
    });
    if (allowed !== true) throw new CatalogAuthorizationError();
    if (
      includePrivate &&
      (await this.authorize({
        ...actor,
        action: 'education.catalog.read-private',
      })) !== true
    )
      throw new CatalogAuthorizationError();
    const scope: Parameters<TenantCatalogReadScope>[0] = {
      collections: ['@happyvertical/smrt-education:Course'],
      authorize: async (scope) =>
        scope.mode === 'catalog' &&
        scope.actorTenantId === tenantId &&
        scope.actorUserId === actorUserId &&
        scope.rootTenantId === tenantId,
    };
    const visible = await this.tenants.withTenantCatalogReadScope(
      scope,
      async () => this.courses.list(options),
    );
    return includePrivate
      ? visible
      : visible.filter((course) => course.licenseKind !== 'personal-use-copy');
  }
}
