/**
 * Project kind and project-to-repository links (#4906).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRepositoryCollection } from '../collections/ProjectRepositories';
import { ProjectCollection } from '../collections/Projects';
import { RepositoryCollection } from '../collections/Repositories';

describe('project kind and repository links', () => {
  let db: DatabaseInterface;
  let projects: ProjectCollection;
  let repos: RepositoryCollection;
  let links: ProjectRepositoryCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    projects = await ProjectCollection.create({ db });
    repos = await RepositoryCollection.create({ db });
    links = await ProjectRepositoryCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  it('leaves kind unset by default and round-trips an assigned kind', async () => {
    const legacy = await projects.create({ title: 'Legacy' });
    expect((await projects.get(legacy.id as string))?.kind ?? null).toBeNull();

    const client = await projects.create({ title: 'Acme', kind: 'client' });
    expect((await projects.get(client.id as string))?.kind).toBe('client');
  });

  it('links many-to-many and answers both directions', async () => {
    const studio = await projects.create({ title: 'Studio', kind: 'internal' });
    const work = await projects.create({ title: 'Work', kind: 'product' });
    const site = await repos.create({ owner: 'hv', name: 'site' });
    const smrt = await repos.create({ owner: 'hv', name: 'smrt' });
    const orphan = await repos.create({ owner: 'hv', name: 'orphan' });

    await links.link(studio.id as string, site.id as string, 'primary');
    await links.link(work.id as string, site.id as string, 'primary');
    await links.link(studio.id as string, smrt.id as string, 'shared-library');
    await links.link(work.id as string, smrt.id as string, 'shared-library');

    const studioRepos = await links.repositoriesOfProject(
      studio.id as string,
      repos,
    );
    expect(studioRepos.map((r) => r.name).sort()).toEqual(['site', 'smrt']);
    expect(
      (
        await links.repositoriesOfProject(
          studio.id as string,
          repos,
          'shared-library',
        )
      ).map((r) => r.name),
    ).toEqual(['smrt']);

    const smrtProjects = await links.projectsOfRepository(
      smrt.id as string,
      projects,
    );
    expect(smrtProjects.map((p) => p.title).sort()).toEqual(['Studio', 'Work']);

    const unassigned = await links.unassignedRepositories(repos);
    expect(unassigned.map((r) => r.id)).toEqual([orphan.id]);
  });

  it('relinking changes the role without duplicating the link', async () => {
    const p = await projects.create({ title: 'P' });
    const r = await repos.create({ owner: 'hv', name: 'r' });
    const first = await links.link(p.id as string, r.id as string, 'primary');
    const second = await links.link(
      p.id as string,
      r.id as string,
      'infrastructure',
    );
    expect(second.id).toBe(first.id);
    const all = await links.list({});
    expect(all).toHaveLength(1);
    expect(all[0].role).toBe('infrastructure');
  });

  it('unlink returns a repository to the unassigned set', async () => {
    const p = await projects.create({ title: 'P' });
    const r = await repos.create({ owner: 'hv', name: 'r' });
    await links.link(p.id as string, r.id as string);
    expect(await links.unassignedRepositories(repos)).toHaveLength(0);
    await links.unlink(p.id as string, r.id as string);
    expect(await links.unassignedRepositories(repos)).toHaveLength(1);
  });

  it('rejects an unknown role', async () => {
    await expect(
      links.link('a', 'b', 'bogus' as unknown as 'primary'),
    ).rejects.toThrow(/Invalid project repository role/);
  });
});
