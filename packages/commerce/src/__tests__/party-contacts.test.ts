/**
 * Contact rows posted by CustomerForm / VendorForm (#3501): the repeated-name
 * payload reads back in DOM order, native add/remove intents never fall
 * through to a save, and savePartyContacts replaces the party's contacts
 * through its tenant-scoped collection, keeping ids stable and refusing
 * foreign ids and other tenants' parties.
 *
 * Real in-memory SQLite with tenancy enabled, per TESTING_STANDARD.md.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { VendorCollection } from '../collections/VendorCollection';
import {
  applyPartyContactIntent,
  normalizePartyContacts,
  PartyContactPartyNotFoundError,
  PartyContactPayloadError,
  PartyContactValidationError,
  readPartyContactRows,
  savePartyContacts,
  validatePartyContactRows,
} from '../party-contacts';

function contactForm(
  rows: Array<[string, string, string, string, string, string]>,
): FormData {
  const form = new FormData();
  form.set('intent', 'save');
  form.set('contactCount', String(rows.length));
  for (const [id, name, label, email, phone, address] of rows) {
    form.append('contactId', id);
    form.append('contactName', name);
    form.append('contactLabel', label);
    form.append('contactEmail', email);
    form.append('contactPhone', phone);
    form.append('contactAddress', address);
  }
  return form;
}

describe('party contact payload', () => {
  it('reads repeated contact fields in DOM order, with caller field names', () => {
    const rows = readPartyContactRows(
      contactForm([
        ['c-1', 'Avery Chen', 'Accounts', 'avery@example.test', '', ''],
        ['', 'Morgan Lee', '', '', '+1 403 555 0117', '1 Main St'],
      ]),
    );
    expect(rows).toEqual([
      {
        id: 'c-1',
        name: 'Avery Chen',
        label: 'Accounts',
        email: 'avery@example.test',
        phone: '',
        address: '',
      },
      {
        id: '',
        name: 'Morgan Lee',
        label: '',
        email: '',
        phone: '+1 403 555 0117',
        address: '1 Main St',
      },
    ]);

    const renamed = new URLSearchParams([
      ['personId', 'p-1'],
      ['personName', 'Sam'],
      ['personCount', '1'],
      ['contactLabel', ''],
      ['contactEmail', ''],
      ['contactPhone', ''],
      ['contactAddress', ''],
    ]);
    expect(
      readPartyContactRows(renamed, {
        contactId: 'personId',
        contactName: 'personName',
        contactCount: 'personCount',
      }),
    ).toEqual([
      { id: 'p-1', name: 'Sam', label: '', email: '', phone: '', address: '' },
    ]);
  });

  it('refuses a misaligned payload instead of pairing values across rows', () => {
    const form = contactForm([['', 'Avery', '', '', '', '']]);
    form.append('contactName', 'Extra');
    expect(() => readPartyContactRows(form)).toThrow(PartyContactPayloadError);
    expect(() => readPartyContactRows(form)).toThrow(/misaligned/);

    const miscounted = contactForm([['', 'Avery', '', '', '', '']]);
    miscounted.set('contactCount', '2');
    expect(() => readPartyContactRows(miscounted)).toThrow(/misaligned/);
  });

  it('reads an empty contact list only when the block posted its marker', () => {
    // The block rendered with no rows: a genuine "no contacts".
    expect(readPartyContactRows(contactForm([]))).toEqual([]);

    // No marker (block not rendered, or fields posted under other names):
    // refuse rather than read zero rows.
    const unmarked = new FormData();
    unmarked.set('intent', 'save');
    unmarked.append('personName', 'Sam');
    const error = (() => {
      try {
        readPartyContactRows(unmarked);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PartyContactPayloadError);
    expect((error as PartyContactPayloadError).reason).toBe('missing');
  });

  it('applies add and remove intents without signalling a save', () => {
    const rows = [{ name: 'A' }, { name: 'B' }];
    expect(applyPartyContactIntent(rows, 'addContact')).toEqual({
      contacts: [{ name: 'A' }, { name: 'B' }, {}],
      handled: true,
    });
    expect(applyPartyContactIntent(rows, 'removeContact:0')).toEqual({
      contacts: [{ name: 'B' }],
      handled: true,
    });
    // A stale remove is still a remove, never a fall-through save.
    expect(applyPartyContactIntent(rows, 'removeContact:9')).toEqual({
      contacts: rows,
      handled: true,
    });
    expect(applyPartyContactIntent(rows, 'save')).toEqual({
      contacts: rows,
      handled: false,
    });
    expect(
      applyPartyContactIntent(rows, 'drop-1', {
        addIntent: 'more',
        parseRemoveIntent: (intent) =>
          intent.startsWith('drop-') ? Number(intent.slice(5)) : undefined,
      }).contacts,
    ).toEqual([{ name: 'A' }]);
  });

  it('trims, drops blank rows, and reports errors at the submitted index', () => {
    const result = validatePartyContactRows([
      { name: '  ', email: '' },
      { name: ' Avery ', email: 'not-an-email' },
      { name: 'x'.repeat(161) },
      { name: 'Morgan', email: ' morgan@example.test ' },
    ]);
    expect(result.contacts.map((row) => row.name)).toEqual([
      'Avery',
      'x'.repeat(161),
      'Morgan',
    ]);
    expect(result.contacts[2]?.email).toBe('morgan@example.test');
    expect(result.errors).toEqual([
      undefined,
      { email: 'invalid_email' },
      { name: 'too_long' },
      undefined,
    ]);
    expect(validatePartyContactRows([{ name: 'Ok' }]).errors).toBeUndefined();
  });

  it('normalizes stored contacts from JSON and drops malformed entries', () => {
    const contacts = normalizePartyContacts(
      JSON.stringify([{ id: 'c-1', name: 'Avery', phone: 42 }, 'junk', null]),
    );
    expect(contacts).toEqual([
      {
        id: 'c-1',
        name: 'Avery',
        label: '',
        email: '',
        phone: '',
        address: '',
      },
    ]);
    expect(normalizePartyContacts('{not json')).toEqual([]);
    expect(normalizePartyContacts(undefined)).toEqual([]);
  });
});

describe('savePartyContacts', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db?.close?.();
  });

  it('replaces vendor contacts, keeping posted ids and assigning new ones', async () => {
    const vendors = await VendorCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      const vendor = await vendors.create({ profileId: 'profile-1' });
      await vendor.save();

      const first = await savePartyContacts(
        vendors,
        vendor.id as string,
        contactForm([
          ['', 'Avery Chen', 'Accounts', 'avery@example.test', '', ''],
          ['', 'Morgan Lee', '', '', '+1 403 555 0117', ''],
          ['', '', '', '', '', ''],
        ]),
      );
      expect(first.map((c) => c.name)).toEqual(['Avery Chen', 'Morgan Lee']);
      const [avery, morgan] = first;
      expect(avery?.id).toMatch(/[0-9a-f-]{36}/);
      expect(morgan?.id).not.toBe(avery?.id);

      // Edit Morgan, remove Avery (not posted), add Sam.
      const second = await savePartyContacts(vendors, vendor.id as string, [
        { id: morgan?.id, name: 'Morgan Lee', label: 'Dispatch' },
        { id: '', name: 'Sam Ortiz' },
      ]);
      expect(second.map((c) => [c.name, c.label])).toEqual([
        ['Morgan Lee', 'Dispatch'],
        ['Sam Ortiz', ''],
      ]);
      expect(second[0]?.id).toBe(morgan?.id);

      const reloaded = await vendors.get({ id: vendor.id as string });
      expect(reloaded?.contacts).toEqual(second);
    });
  });

  it('keeps every contact when the posted form lacks the contact marker', async () => {
    const vendors = await VendorCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      const vendor = await vendors.create({ profileId: 'profile-1' });
      await vendor.save();
      await savePartyContacts(vendors, vendor.id as string, [
        { name: 'Avery' },
        { name: 'Morgan' },
      ]);

      // Fields posted under custom names, read with the defaults.
      const renamed = new FormData();
      renamed.set('personCount', '0');
      await expect(
        savePartyContacts(vendors, vendor.id as string, renamed),
      ).rejects.toBeInstanceOf(PartyContactPayloadError);
      // The same form with matching names is a real "remove all".
      const reloaded = await vendors.get({ id: vendor.id as string });
      expect(reloaded?.contacts.map((c) => c.name)).toEqual([
        'Avery',
        'Morgan',
      ]);
      await savePartyContacts(vendors, vendor.id as string, renamed, {
        fieldNames: { contactCount: 'personCount' },
      });
      const cleared = await vendors.get({ id: vendor.id as string });
      expect(cleared?.contacts).toEqual([]);
    });
  });

  it('writes customer contacts the same way', async () => {
    const customers = await CustomerCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      const customer = await customers.create({ profileId: 'profile-1' });
      await customer.save();
      await savePartyContacts(customers, customer.id as string, [
        { name: 'Avery Chen', email: 'avery@example.test' },
      ]);
      const reloaded = await customers.get({ id: customer.id as string });
      expect(reloaded?.contacts).toMatchObject([
        { name: 'Avery Chen', email: 'avery@example.test' },
      ]);
    });
  });

  it('rejects invalid rows and foreign contact ids without writing', async () => {
    const vendors = await VendorCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      const vendor = await vendors.create({ profileId: 'profile-1' });
      await vendor.save();
      const [saved] = await savePartyContacts(vendors, vendor.id as string, [
        { name: 'Avery' },
      ]);

      const failure = await savePartyContacts(vendors, vendor.id as string, [
        { id: saved?.id, name: 'Avery', email: 'nope' },
        { id: 'someone-elses-contact', name: 'Intruder' },
      ]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PartyContactValidationError);
      expect((failure as PartyContactValidationError).errors).toEqual([
        { email: 'invalid_email' },
        { id: 'unknown_contact' },
      ]);

      const foreignOnly = await savePartyContacts(
        vendors,
        vendor.id as string,
        [{ name: 'Avery' }, { id: 'someone-elses-contact', name: 'Intruder' }],
      ).catch((error: unknown) => error);
      expect((foreignOnly as PartyContactValidationError).errors).toEqual([
        undefined,
        { id: 'unknown_contact' },
      ]);

      const reloaded = await vendors.get({ id: vendor.id as string });
      expect(reloaded?.contacts.map((c) => c.name)).toEqual(['Avery']);
      expect(reloaded?.contacts[0]?.id).toBe(saved?.id);
    });
  });

  it("does not find another tenant's party or one outside the expected tenant", async () => {
    const vendors = await VendorCollection.create({ db });
    const vendorId = await withTenant({ tenantId: 'tenant-1' }, async () => {
      const vendor = await vendors.create({ profileId: 'profile-1' });
      await vendor.save();
      return vendor.id as string;
    });

    await expect(
      withTenant({ tenantId: 'tenant-2' }, () =>
        savePartyContacts(vendors, vendorId, [{ name: 'Intruder' }]),
      ),
    ).rejects.toBeInstanceOf(PartyContactPartyNotFoundError);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        savePartyContacts(vendors, vendorId, [{ name: 'Avery' }], {
          expectedTenantId: 'tenant-2',
        }),
      ),
    ).rejects.toBeInstanceOf(PartyContactPartyNotFoundError);

    const reloaded = await withTenant({ tenantId: 'tenant-1' }, () =>
      vendors.get({ id: vendorId }),
    );
    expect(reloaded?.contacts).toEqual([]);
  });
});
