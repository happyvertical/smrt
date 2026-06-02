/**
 * Tests for the {@link LicenseSale} Contract STI subtype — covers the
 * issue's acceptance criteria:
 *
 * - the `LicenseSale` subtype works like the existing STI subtypes
 *   (right `_meta_type`, right `contractType`, polymorphic query)
 * - `ContractType.LICENSE_SALE` enum value is wired up
 * - create from a Sku purchase, persisting all rights-snapshot fields
 *   plus the signed-PDF reference
 * - an *issued* (status=ACCEPTED) LicenseSale's rights snapshot is
 *   immutable — mutating any of the seven rights fields and trying
 *   to save throws
 * - revoke() transitions to CANCELLED without touching the rights
 * - query-by-licensee-email via the normal ContractCollection.list
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { LicenseSale } from '../models/Contract.js';
import { ContractStatus, ContractType } from '../types/index.js';

describe('LicenseSale STI subtype', () => {
  let dbPath: string;
  let contracts: ContractCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-license-sale-${Date.now()}.db`);
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('exposes a LICENSE_SALE enum value', () => {
    expect(ContractType.LICENSE_SALE).toBe('license_sale');
  });

  it('stamps the right _meta_type and contractType', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
    });
    await license.initialize();
    expect(license.toJSON()._meta_type).toBe(
      '@happyvertical/smrt-commerce:LicenseSale',
    );
    expect(license.contractType).toBe(ContractType.LICENSE_SALE);
  });

  it('resolves Contract as the STI base for LicenseSale', () => {
    // R5-canon: getSTIBase returns qualified names.
    expect(ObjectRegistry.getSTIBase('LicenseSale')).toBe(
      '@happyvertical/smrt-commerce:Contract',
    );
  });

  it('persists a license issued against a Sku purchase', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      skuId: 'sku-ergot-1',
      paymentId: 'pmt-1',
      licenseeEmail: 'buyer@example.test',
      licenseeLegalEntity: 'Buyer Studios LLC',
      licenseeJurisdiction: 'US-NY',
      rightsMedium: 'web,print',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'non-exclusive',
      rightsDuration: 'perpetual',
      rightsTerritory: 'worldwide',
      rightsSublicensing: false,
      rightsDerivatives: true,
      pdfUrl: 'https://cdn.example.test/license/abc.pdf',
      pdfHash:
        '4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
      status: ContractStatus.ACCEPTED,
      customerId: 'cust-1',
      totalAmount: 199.0,
      currency: 'USD',
      channelId: 'marketplace-direct',
    });
    await license.initialize();
    await license.save();

    const loaded = (await contracts.get({
      id: license.id,
    })) as LicenseSale | null;
    expect(loaded).toBeInstanceOf(LicenseSale);
    expect(loaded?.contractType).toBe(ContractType.LICENSE_SALE);
    expect(loaded?.skuId).toBe('sku-ergot-1');
    expect(loaded?.paymentId).toBe('pmt-1');
    expect(loaded?.licenseeEmail).toBe('buyer@example.test');
    expect(loaded?.licenseeLegalEntity).toBe('Buyer Studios LLC');
    expect(loaded?.licenseeJurisdiction).toBe('US-NY');
    expect(loaded?.rightsMedium).toBe('web,print');
    expect(loaded?.rightsDistributionScope).toBe('worldwide');
    expect(loaded?.rightsExclusivity).toBe('non-exclusive');
    expect(loaded?.rightsDuration).toBe('perpetual');
    expect(loaded?.rightsTerritory).toBe('worldwide');
    expect(loaded?.rightsSublicensing).toBe(false);
    expect(loaded?.rightsDerivatives).toBe(true);
    expect(loaded?.pdfUrl).toBe('https://cdn.example.test/license/abc.pdf');
    expect(loaded?.pdfHash).toBe(
      '4cb2e2d8b9e7f5a3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
    );
    expect(loaded?.totalAmount).toBe(199.0);
    expect(loaded?.channelId).toBe('marketplace-direct');
  });

  it('exposes the rights snapshot as a typed object', () => {
    const license = new LicenseSale({
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'exclusive',
      rightsDuration: '12-months',
      rightsTerritory: 'US,CA',
      rightsSublicensing: true,
      rightsDerivatives: false,
    });
    expect(license.getRightsSnapshot()).toEqual({
      medium: 'web',
      distributionScope: 'worldwide',
      exclusivity: 'exclusive',
      duration: '12-months',
      territory: 'US,CA',
      sublicensing: true,
      derivatives: false,
    });
  });

  it('freezes the rights snapshot once the license is issued (loaded ACCEPTED)', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      skuId: 'sku-immut-1',
      paymentId: 'pmt-immut-1',
      licenseeEmail: 'buyer@example.test',
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'non-exclusive',
      rightsDuration: 'perpetual',
      rightsTerritory: 'worldwide',
      rightsSublicensing: false,
      rightsDerivatives: false,
      pdfUrl: 'https://cdn.example.test/license/immut.pdf',
      pdfHash: 'feedface',
      status: ContractStatus.ACCEPTED,
      customerId: 'cust-immut',
      totalAmount: 50,
      currency: 'USD',
    });
    await license.initialize();
    await license.save();

    const loaded = (await contracts.get({
      id: license.id,
    })) as LicenseSale | null;
    expect(loaded).toBeInstanceOf(LicenseSale);

    // Mutating any rights field on a loaded-ACCEPTED row trips the
    // immutability guard at save time.
    loaded!.rightsMedium = 'web,print,broadcast';
    await expect(loaded?.save()).rejects.toThrow(/immutable once issued/);
  });

  it('allows accepted-license rights to change before the first save', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      licenseeEmail: 'new-issued@example.test',
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'non-exclusive',
      rightsDuration: 'perpetual',
      rightsTerritory: 'US',
      rightsSublicensing: false,
      rightsDerivatives: false,
      status: ContractStatus.ACCEPTED,
      customerId: 'c-new-issued',
      totalAmount: 100,
    });
    await license.initialize();

    license.rightsTerritory = 'US,CA';
    await expect(license.save()).resolves.toBeDefined();

    license.rightsTerritory = 'worldwide';
    await expect(license.save()).rejects.toThrow(/immutable once issued/);
  });

  it('detects mutation of a boolean rights field', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      licenseeEmail: 'buyer@example.test',
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'non-exclusive',
      rightsDuration: 'perpetual',
      rightsTerritory: 'worldwide',
      rightsSublicensing: false,
      rightsDerivatives: false,
      pdfHash: 'baadf00d',
      status: ContractStatus.ACCEPTED,
      customerId: 'c-1',
      totalAmount: 100,
    });
    await license.initialize();
    await license.save();

    const loaded = (await contracts.get({
      id: license.id,
    })) as LicenseSale;
    loaded.rightsSublicensing = true; // boolean flip is also a mutation
    await expect(loaded.save()).rejects.toThrow(/immutable once issued/);
  });

  it('lets a draft license update its rights freely until issuance', async () => {
    // Drafts (status != ACCEPTED) are mutable — the freeze only kicks
    // in once the row is saved at ACCEPTED.
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      licenseeEmail: 'drafter@example.test',
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'non-exclusive',
      rightsDuration: '12-months',
      rightsTerritory: 'US',
      rightsSublicensing: false,
      rightsDerivatives: false,
      status: ContractStatus.DRAFT,
      customerId: 'c-draft',
      totalAmount: 25,
    });
    await license.initialize();
    await license.save();

    // Drafted, mutate rights, save again — still fine.
    license.rightsMedium = 'web,social';
    license.rightsTerritory = 'US,CA';
    await expect(license.save()).resolves.toBeDefined();

    // Now issue it — moves to ACCEPTED and freezes.
    license.status = ContractStatus.ACCEPTED;
    await license.save();
    license.rightsTerritory = 'worldwide';
    await expect(license.save()).rejects.toThrow(/immutable once issued/);
  });

  it('revokes an issued license to CANCELLED without touching rights', async () => {
    const license = new LicenseSale({
      db: { type: 'sqlite', url: dbPath },
      licenseeEmail: 'buyer@example.test',
      rightsMedium: 'web',
      rightsDistributionScope: 'worldwide',
      rightsExclusivity: 'exclusive',
      rightsDuration: 'perpetual',
      rightsTerritory: 'worldwide',
      rightsSublicensing: false,
      rightsDerivatives: false,
      pdfHash: 'cafebabe',
      status: ContractStatus.ACCEPTED,
      customerId: 'c-revoke',
      totalAmount: 999,
    });
    await license.initialize();
    await license.save();

    license.revoke();
    expect(license.status).toBe(ContractStatus.CANCELLED);
    // Rights unchanged — the immutability guard is happy with the
    // save even though we transitioned status.
    await expect(license.save()).resolves.toBeDefined();

    const loaded = (await contracts.get({
      id: license.id,
    })) as LicenseSale;
    expect(loaded.status).toBe(ContractStatus.CANCELLED);
    expect(loaded.rightsExclusivity).toBe('exclusive');
  });

  it('refuses to revoke a draft license', () => {
    const license = new LicenseSale({
      licenseeEmail: 'buyer@example.test',
      status: ContractStatus.DRAFT,
    });
    expect(() => license.revoke()).toThrow(/only ACCEPTED licenses/);
  });

  it('queries by licensee email via the normal STI collection list', async () => {
    // Three licenses for two different licensees; findByType filters
    // to LicenseSale; a where-clause filter then narrows by email.
    for (const [email, sku] of [
      ['shared@example.test', 'sku-A'],
      ['shared@example.test', 'sku-B'],
      ['other@example.test', 'sku-C'],
    ] as const) {
      const license = new LicenseSale({
        db: { type: 'sqlite', url: dbPath },
        skuId: sku,
        licenseeEmail: email,
        rightsMedium: 'web',
        rightsDistributionScope: 'worldwide',
        rightsExclusivity: 'non-exclusive',
        rightsDuration: 'perpetual',
        rightsTerritory: 'worldwide',
        rightsSublicensing: false,
        rightsDerivatives: false,
        status: ContractStatus.ACCEPTED,
        customerId: 'c-shared',
        totalAmount: 10,
      });
      await license.initialize();
      await license.save();
    }

    const all = await contracts.findByType(ContractType.LICENSE_SALE);
    expect(all).toHaveLength(3);
    expect(all.every((c) => c instanceof LicenseSale)).toBe(true);

    const forShared = all.filter(
      (c) => (c as LicenseSale).licenseeEmail === 'shared@example.test',
    );
    expect(forShared).toHaveLength(2);
  });
});
