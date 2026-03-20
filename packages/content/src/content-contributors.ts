import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { ContentContributor } from './content-contributor';

export class ContentContributorCollection extends SmrtCollection<ContentContributor> {
  static readonly _itemClass = ContentContributor;

  async getByEmail(email: string): Promise<ContentContributor | null> {
    return this.get({ email: email.toLowerCase().trim() });
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
    const existing = await this.getByEmail(normalizedEmail);
    if (existing) {
      if (options.name && !existing.name) {
        existing.name = options.name;
        await existing.save();
      }
      return existing;
    }

    const profileCollection = await ProfileCollection.create(this.options);
    let profile = await profileCollection.findByEmail(normalizedEmail);

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
        tenantId: options.tenantId || undefined,
      });
      await profile.save();
    }

    const contributor = await this.create({
      email: normalizedEmail,
      name: options.name || profile.name || normalizedEmail.split('@')[0],
      profileId: profile.id || undefined,
      tenantId: options.tenantId || undefined,
      trustLevel: 'standard',
    });
    await contributor.save();
    return contributor;
  }
}
