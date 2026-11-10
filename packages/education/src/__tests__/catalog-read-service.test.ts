import { describe, expect, it, vi } from 'vitest';
import { CatalogReadService } from '../catalog-read-service.js';

const record = {
  id: 'course',
  providerId: 'provider',
  stableId: 'course',
  revision: 'r1',
  canonicalUrl: 'https://catalog.test/course',
  title: 'Course',
  visibility: 'catalog' as const,
  licenseEvidence: {
    state: 'verified' as const,
    identifier: 'CC-BY',
    sourceUrl: 'https://private-license-source.test',
    permittedOperations: ['print' as const],
  },
};
const actor = {
  tenantId: 'tenant',
  actorUserId: 'guardian',
  roles: ['guardian'],
};

describe('CatalogReadService', () => {
  it('projects public metadata only and never exposes license evidence source URLs', async () => {
    const search = vi.fn(async () => [record]);
    const views = await new CatalogReadService({ search }).search(actor, {
      query: 'course',
    });
    expect(search).toHaveBeenCalledWith({ query: 'course' });
    expect(views).toEqual([
      expect.objectContaining({ id: 'course', title: 'Course' }),
    ]);
    expect(JSON.stringify(views)).not.toContain('private-license-source');
  });

  it('filters teacher records before forming learner DTOs', async () => {
    const service = new CatalogReadService({
      search: async () => [
        { ...record, id: 'answer', visibility: 'teacher' as const },
      ],
    });
    await expect(service.search(actor)).resolves.toEqual([]);
    await expect(
      service.search({ ...actor, roles: ['teacher'] }),
    ).resolves.toHaveLength(1);
  });
});
