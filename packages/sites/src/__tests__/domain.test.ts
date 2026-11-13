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
    expect(await service.domainsByZone('t1', zone.id as string)).toHaveLength(
      3,
    );
    expect((await domains.findByHostname('www.example.com'))?.zoneId).toBe(
      zone.id,
    );
  });

  it('links one zone to many projects and lists by project/role', async () => {
    const { work, www } = await seed();
    await links.assign(work, 'proj-a', 'production');
    await links.assign(www, 'proj-b', 'production');
    await links.assign(www, 'proj-a', 'staging');

    const a = await service.domainsByProject('t1', 'proj-a');
    expect(a.map((d) => d.hostname).sort()).toEqual([
      'work.example.com',
      'www.example.com',
    ]);
    const aStaging = await service.domainsByProject('t1', 'proj-a', 'staging');
    expect(aStaging.map((d) => d.hostname)).toEqual(['www.example.com']);
    expect(await service.domainsByProject('t1', 'nope')).toEqual([]);
  });

  it('assign is idempotent and unassigned excludes linked domains', async () => {
    const { work } = await seed();
    const one = await links.assign(work, 'proj-a');
    const two = await links.assign(work, 'proj-a');
    expect(two.id).toBe(one.id);
    expect(await links.findByDomain(work.id as string)).toHaveLength(1);
    const unassigned = await service.unassignedDomains('t1');
    expect(unassigned.map((d) => d.hostname).sort()).toEqual([
      'spare.example.com',
      'www.example.com',
    ]);
  });

  it('rejects assign with a tenant that does not own the domain', async () => {
    const { work } = await seed();
    await expect(
      links.assign(work, 'proj-a', 'production', 't2'),
    ).rejects.toThrow(/Tenant mismatch/);
    const ok = await links.assign(work, 'proj-a', 'production', 't1');
    expect(ok.tenantId).toBe('t1');
  });

  it('isolates tenants across zone, project and unassigned helpers', async () => {
    const { zone, work } = await seed();
    const zone2 = await zones.create({ tenantId: 't2', name: 'other.com' });
    await zone2.save();
    const d2 = await domains.create({
      tenantId: 't2',
      zoneId: zone2.id,
      hostname: 'app.other.com',
    });
    await d2.save();
    const d2b = await domains.create({
      tenantId: 't2',
      zoneId: zone2.id,
      hostname: 'mail.other.com',
    });
    await d2b.save();
    // Same project id used by both tenants
    await links.assign(work, 'proj-a');
    await links.assign(d2, 'proj-a');

    expect(await service.domainsByZone('t1', zone2.id as string)).toEqual([]);
    expect(
      (await service.domainsByZone('t2', zone2.id as string)).map(
        (d) => d.hostname,
      ),
    ).toHaveLength(2);
    expect(await service.domainsByZone('t2', zone.id as string)).toEqual([]);

    expect(
      (await service.domainsByProject('t1', 'proj-a')).map((d) => d.hostname),
    ).toEqual(['work.example.com']);
    expect(
      (await service.domainsByProject('t2', 'proj-a')).map((d) => d.hostname),
    ).toEqual(['app.other.com']);

    expect(
      (await service.unassignedDomains('t2')).map((d) => d.hostname),
    ).toEqual(['mail.other.com']);
    expect(
      (await service.unassignedDomains('t1')).map((d) => d.hostname).sort(),
    ).toEqual(['spare.example.com', 'www.example.com']);
  });
});
