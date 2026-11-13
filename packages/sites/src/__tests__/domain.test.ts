/**
 * DnsZone / Domain / ProjectDomain tests (in-process SQLite)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DnsZoneCollection } from '../collections/DnsZoneCollection';
import { DomainCollection } from '../collections/DomainCollection';
import { ProjectDomainCollection } from '../collections/ProjectDomainCollection';
import { DomainService } from '../services/DomainService';

describe('zones, domains and project links', () => {
  let dbPath: string;
  let zones: DnsZoneCollection;
  let domains: DomainCollection;
  let links: ProjectDomainCollection;
  let service: DomainService;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-domain-test-${Date.now()}-${Math.random()}.db`,
    );
    const db = { type: 'sqlite' as const, url: dbPath };
    zones = await DnsZoneCollection.create({ db });
    domains = await DomainCollection.create({ db });
    links = await ProjectDomainCollection.create({ db });
    service = new DomainService({ domains, links });
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  async function seed() {
    const zone = await zones.create({ tenantId: 't1', name: 'example.com' });
    await zone.save();
    const mk = async (hostname: string) => {
      const d = await domains.create({
        tenantId: 't1',
        zoneId: zone.id,
        hostname,
      });
      await d.save();
      return d;
    };
    return {
      zone,
      work: await mk('work.example.com'),
      www: await mk('www.example.com'),
      spare: await mk('spare.example.com'),
    };
  }

  it('finds zones by name and domains by zone', async () => {
    const { zone } = await seed();
    expect((await zones.findByName('example.com'))?.id).toBe(zone.id);
    expect(await service.domainsByZone(zone.id as string)).toHaveLength(3);
    expect((await domains.findByHostname('www.example.com'))?.zoneId).toBe(
      zone.id,
    );
  });

  it('links one zone to many projects and lists by project/role', async () => {
    const { work, www } = await seed();
    await links.assign('t1', work.id as string, 'proj-a', 'production');
    await links.assign('t1', www.id as string, 'proj-b', 'production');
    await links.assign('t1', www.id as string, 'proj-a', 'staging');

    const a = await service.domainsByProject('proj-a');
    expect(a.map((d) => d.hostname).sort()).toEqual([
      'work.example.com',
      'www.example.com',
    ]);
    const aStaging = await service.domainsByProject('proj-a', 'staging');
    expect(aStaging.map((d) => d.hostname)).toEqual(['www.example.com']);
    expect(await service.domainsByProject('nope')).toEqual([]);
  });

  it('assign is idempotent and unassigned excludes linked domains', async () => {
    const { work } = await seed();
    const one = await links.assign('t1', work.id as string, 'proj-a');
    const two = await links.assign('t1', work.id as string, 'proj-a');
    expect(two.id).toBe(one.id);
    expect(await links.findByDomain(work.id as string)).toHaveLength(1);
    const unassigned = await service.unassignedDomains();
    expect(unassigned.map((d) => d.hostname).sort()).toEqual([
      'spare.example.com',
      'www.example.com',
    ]);
  });
});
