import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { ContentContributor } from './content-contributor';
import { getByTenantKey, resolveLookupTenantId } from './tenant-keyed-lookup';

// The collection's own @smrt() surface: its read helpers are published
// operations (the API explorer and the workbench call them). A collection
// inherits only its model's CRUD verbs, so it lists the helpers it opens here.
// The CRUD verbs repeat the model's because a collection decorator's config
// is merged over its model's at runtime.
@smrt({
  // Mirror the model's storage so the collection decorator cannot plan a
  // different table or natural key for it.
  tableName: 'content_contributors',
  conflictColumns: ['tenant_id', 'email'],
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'getByEmail',
      'getByProfileId',
    ],
  },
  mcp: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'getByEmail',
      'getByProfileId',
    ],
  },
})
export class ContentContributorCollection extends SmrtCollection<ContentContributor> {
  static readonly _itemClass = ContentContributor;

  /**
   * The contributor for `email` in one tenant: `options.tenantId`, else the
   * active tenant context; without either, the global (NULL-tenant)
   * contributor. Emails are unique per tenant (#3305 M1), so this never
   * returns another tenant's contributor, and a tenant does not inherit a
   * global contributor's identity or trust level.
   */
  async getByEmail(
    email: string,
    options: { tenantId?: string | null } = {},
  ): Promise<ContentContributor | null> {
    return getByTenantKey(this, 'email', email.toLowerCase().trim(), {
      tenantId: options.tenantId,
      globalFallback: false,
      label: 'ContentContributorCollection.getByEmail',
    });
  }

  async getByProfileId(profileId: string): Promise<ContentContributor | null> {
    return this.get({ profileId });
  }

  async findOrCreateByEmail(options: {
    email: string;
    name?: string | null;
    tenantId?: string | null;
  }): Promise<ContentContributor> {
    const normalizedEmail = options.email.toLowerCase().trim();
    // Look up and create in the same tenant, so a retry finds the row it
    // created and another tenant's same-email contributor is never reused.
    const tenantId = resolveLookupTenantId(options.tenantId || undefined);
    const existing = await this.getByEmail(normalizedEmail, { tenantId });
    if (existing) {
      if (options.name && !existing.name) {
        existing.name = options.name;
        await existing.save();
      }
      return existing;
    }

    const profileCollection = await ProfileCollection.create(this.options);
    // Link a profile from the contributor's own tenant (or a global profile
    // for a global contributor), never another tenant's same-email profile.
    let profile =
      (
        await profileCollection.list({
          where: { email: normalizedEmail, tenantId },
          limit: 1,
        })
      )[0] ?? null;

    if (!profile) {
      const profileTypes = await ProfileTypeCollection.create(this.options);
      const personType = await profileTypes.getOrCreateBySlug('person', {
        name: 'Person',
        description: 'Individual person',
      });

      profile = await profileCollection.create({
        typeId: personType.id || undefined,
        email: normalizedEmail,
        name: options.name || normalizedEmail.split('@')[0],
        tenantId: tenantId || undefined,
      });
      await profile.save();
    }

    const contributor = await this.create({
      email: normalizedEmail,
      name: options.name || profile.name || normalizedEmail.split('@')[0],
      profileId: profile.id || undefined,
      tenantId: tenantId || undefined,
      trustLevel: 'standard',
    });
    await contributor.save();
    return contributor;
  }
}
