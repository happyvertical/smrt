import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import type { CatalogField, CatalogModel } from '../src/lib/catalog/types.ts';
import { displayLabel, labelFields } from '../src/lib/data/display.ts';
import { enumLabel, formatValue, labelKey } from '../src/lib/data/format.ts';
import {
  CUSTOMER,
  PROFILE,
  recordLabel,
  relationLabels,
  resolveCustomer,
  searchCustomers,
  searchRelated,
  searchVendors,
  VENDOR,
} from '../src/lib/data/labels.ts';
import {
  createMemoryDataSource,
  type DataSource,
} from '../src/lib/data/source.ts';
import { fromAddressInput, toAddressInput } from '../src/lib/fields/address.ts';
import { chooseRenderer } from '../src/lib/fields/renderer.ts';
import { activeForms, isFieldMap } from '../src/lib/forms/active.ts';
import {
  blankFieldMap,
  findFieldMapRows,
  loadFieldMap,
  planFieldMapSave,
} from '../src/lib/forms/fieldMap.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import type { FieldMapForm } from '../src/lib/recipes/types.ts';
import { customerOption } from '../src/lib/upstream/partySelect.ts';
import { selectorFor } from '../src/lib/upstream/selects.ts';

const COMMERCE = '@happyvertical/smrt-commerce';
const ORDER = `${COMMERCE}:Order`;
const PURCHASE_ORDER = `${COMMERCE}:PurchaseOrder`;
const STOCK = '@happyvertical/smrt-inventory:StockLevel';
const SKU = '@happyvertical/smrt-products:Sku';

const model = (id: string): CatalogModel => {
  const found = getModelByQualifiedName(id)?.model;
  if (!found) throw new Error(`no model ${id}`);
  return found;
};
const field = (modelId: string, name: string): CatalogField => {
  const found = model(modelId).fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${modelId}.${name}`);
  return found;
};
const renderer = (modelId: string, name: string) =>
  chooseRenderer(field(modelId, name), modelId);

describe('the renderer chosen per field', () => {
  it('gives a Sales Order the right input for each field', () => {
    expect(renderer(ORDER, 'customerId')).toBe('relation');
    expect(renderer(ORDER, 'status')).toBe('enum');
    expect(renderer(ORDER, 'terms')).toBe('textarea');
    expect(renderer(ORDER, 'notes')).toBe('textarea');
    expect(renderer(ORDER, 'currency')).toBe('currency');
    expect(renderer(ORDER, 'issueDate')).toBe('datetime');
    expect(renderer(ORDER, 'dueDate')).toBe('datetime');
    expect(renderer(ORDER, 'totalAmount')).toBe('money');
    expect(renderer(ORDER, 'reference')).toBe('text');
  });

  it('gives a Purchase Order a Vendor selector', () => {
    expect(renderer(PURCHASE_ORDER, 'vendorId')).toBe('relation');
    expect(renderer(PURCHASE_ORDER, 'status')).toBe('enum');
  });

  it('covers Customers and Vendors', () => {
    expect(renderer(CUSTOMER, 'status')).toBe('enum');
    expect(renderer(CUSTOMER, 'customerType')).toBe('enum');
    expect(renderer(CUSTOMER, 'defaultShippingAddress')).toBe('address');
    expect(renderer(CUSTOMER, 'creditLimit')).toBe('money');
    expect(renderer(CUSTOMER, 'taxExempt')).toBe('boolean');
    expect(renderer(CUSTOMER, 'profileId')).toBe('relation');
    expect(renderer(VENDOR, 'defaultContactEmail')).toBe('email');
    expect(renderer(VENDOR, 'defaultContactPhone')).toBe('phone');
    expect(renderer(VENDOR, 'currency')).toBe('currency');
    expect(renderer(VENDOR, 'minimumOrderAmount')).toBe('money');
    expect(renderer(VENDOR, 'leadTimeDays')).toBe('integer');
    expect(renderer(VENDOR, 'payoutAddresses')).toBe('json');
    expect(renderer(PROFILE, 'email')).toBe('email');
  });

  it('gives Inventory references a selector, not an id box', () => {
    expect(renderer(STOCK, 'skuId')).toBe('relation');
    expect(renderer(STOCK, 'locationId')).toBe('relation');
    expect(renderer(STOCK, 'state')).toBe('enum');
    expect(field(STOCK, 'skuId').related).toBe(SKU);
    expect(renderer(SKU, 'productId')).toBe('relation');
  });

  it('chooses by type and hint when a field has no model context', () => {
    const base = { name: 'x', required: false };
    expect(chooseRenderer({ ...base, type: 'text', enum: ['a'] })).toBe('enum');
    expect(chooseRenderer({ ...base, type: 'text', enum: [] })).toBe('text');
    expect(
      chooseRenderer({ ...base, type: 'text', ui: { widget: 'url' } }),
    ).toBe('url');
    expect(chooseRenderer({ ...base, type: 'foreignKey' })).toBe('text');
    expect(
      chooseRenderer({ ...base, type: 'crossPackageRef', related: 'a:B' }),
    ).toBe('relation');
    expect(chooseRenderer({ ...base, type: 'decimal' })).toBe('decimal');
    expect(chooseRenderer({ ...base, type: 'integer' })).toBe('integer');
    expect(chooseRenderer({ ...base, type: 'json' })).toBe('json');
    expect(chooseRenderer({ ...base, type: 'boolean' })).toBe('boolean');
  });
});

describe('enum values (stand-in for smrt#3598)', () => {
  it('are the real ContractStatus values, in declaration order', () => {
    expect(field(ORDER, 'status').enum).toEqual([
      'draft',
      'sent',
      'accepted',
      'declined',
      'completed',
      'cancelled',
    ]);
    expect(field(PURCHASE_ORDER, 'status').enum).toEqual(
      field(ORDER, 'status').enum,
    );
  });

  it('are the real CustomerType, CustomerStatus and VendorStatus values', () => {
    expect(field(CUSTOMER, 'customerType').enum).toEqual([
      'dtc',
      'wholesale',
      'retail',
    ]);
    expect(field(CUSTOMER, 'status').enum).toEqual([
      'active',
      'inactive',
      'suspended',
    ]);
    expect(field(VENDOR, 'status').enum).toEqual([
      'active',
      'inactive',
      'suspended',
    ]);
  });

  it('show as labels in a list cell', () => {
    expect(formatValue(field(ORDER, 'status'), 'accepted')).toBe('Accepted');
    expect(formatValue(field(CUSTOMER, 'customerType'), 'dtc')).toBe('DTC');
  });

  it('label options without changing the stored value', () => {
    expect(enumLabel('draft')).toBe('Draft');
    expect(enumLabel('qc_hold')).toBe('Qc hold');
    expect(enumLabel('dtc')).toBe('DTC');
  });
});

describe('selector lookup by `selects` (stand-in for smrt#3599)', () => {
  it('finds the registered selector for a model', () => {
    expect(selectorFor(CUSTOMER)?.name).toBe('CustomerSelect');
    expect(selectorFor(VENDOR)?.name).toBe('VendorSelect');
    expect(selectorFor(CUSTOMER)?.selects).toBe(CUSTOMER);
  });

  it('has none for a model without one, so the generic picker is used', () => {
    expect(selectorFor(SKU)).toBeUndefined();
    expect(selectorFor(PROFILE)).toBeUndefined();
    expect(selectorFor(CUSTOMER, [])).toBeUndefined();
  });
});

describe('display label (stand-in for smrt#3599)', () => {
  it('defaults to the first of name, title, label, code', () => {
    expect(labelFields(model(PROFILE))[0]).toBe('name');
    expect(labelFields(model(SKU))).toEqual(['name', 'code']);
    expect(displayLabel(model(SKU), { name: '', code: 'BLUE-TEE' })).toBe(
      'BLUE-TEE',
    );
    expect(displayLabel(model(SKU), { name: 'Blue tee' })).toBe('Blue tee');
  });

  it("prefers the model's declared field when it has one", () => {
    const declared = { ...model(SKU), display: { label: 'barcode' } };
    expect(labelFields(declared)[0]).toBe('barcode');
  });
});

describe('Customers and Vendors get names', () => {
  const customerForm = (): ReturnType<typeof activeForms>[number] & {
    form: FieldMapForm;
  } => {
    const found = activeForms(['commerce.customers'], recipes, CUSTOMER).find(
      isFieldMap,
    );
    if (!found) throw new Error('commerce.customers has no form');
    return found;
  };
  const vendorForm = () => {
    const found = activeForms(['commerce.vendors'], recipes, VENDOR).find(
      isFieldMap,
    );
    if (!found) throw new Error('commerce.vendors has no form');
    return found;
  };
  const fresh = (): DataSource => createMemoryDataSource();

  it('saves a Profile together with the Customer', async () => {
    const source = fresh();
    const active = customerForm();
    const profiles = await source.list(model(PROFILE));
    const customers = await source.list(model(CUSTOMER));
    const writes = planFieldMapSave(active, catalogModels, {
      ...blankFieldMap(active, catalogModels),
      name: 'Acme Hardware',
      email: 'buyer@acme.example',
      customerType: 'wholesale',
      creditLimit: 250000,
    });
    // Profile type, Profile, Customer, in that order.
    expect(writes.map((w) => w.op === 'save' && w.as)).toEqual([
      'profileType',
      'profile',
      'customer',
    ]);
    const saved = await source.apply(writes);
    expect(saved.profile).toMatchObject({
      name: 'Acme Hardware',
      email: 'buyer@acme.example',
      typeId: saved.profileType?.id,
    });
    expect(saved.customer).toMatchObject({
      profileId: saved.profile?.id,
      status: 'active',
      customerType: 'wholesale',
      creditLimit: 250000,
    });
    expect(await source.list(model(PROFILE))).toHaveLength(profiles.length + 1);
    expect(await source.list(model(CUSTOMER))).toHaveLength(
      customers.length + 1,
    );
    const types = await source.list(
      catalogModels('@happyvertical/smrt-profiles:ProfileType'),
    );
    expect(types.filter((t) => t.name === 'Customer')).toHaveLength(1);
  });

  it('reuses the Profile type on the next customer', async () => {
    const source = fresh();
    const active = customerForm();
    for (const name of ['One', 'Two']) {
      await source.apply(
        planFieldMapSave(active, catalogModels, {
          ...blankFieldMap(active, catalogModels),
          name,
        }),
      );
    }
    const types = await source.list(
      catalogModels('@happyvertical/smrt-profiles:ProfileType'),
    );
    expect(types.filter((t) => t.name === 'Customer')).toHaveLength(1);
  });

  it('edits the same Profile and Customer in place', async () => {
    const source = fresh();
    const active = customerForm();
    const saved = await source.apply(
      planFieldMapSave(active, catalogModels, {
        ...blankFieldMap(active, catalogModels),
        name: 'Acme Hardware',
      }),
    );
    const id = saved.customer?.id ?? '';
    const loaded = await loadFieldMap(source, active, catalogModels, id);
    expect(loaded.name).toBe('Acme Hardware');
    const rows = await findFieldMapRows(source, active, catalogModels, id);
    expect(rows.profile?.id).toBe(saved.profile?.id);

    const profiles = (await source.list(model(PROFILE))).length;
    const customers = (await source.list(model(CUSTOMER))).length;
    await source.apply(
      planFieldMapSave(
        active,
        catalogModels,
        { ...loaded, name: 'Acme Tools', status: 'suspended' },
        id,
        rows,
      ),
    );
    expect(await source.list(model(PROFILE))).toHaveLength(profiles);
    expect(await source.list(model(CUSTOMER))).toHaveLength(customers);
    expect(
      (await source.get(model(PROFILE), saved.profile?.id ?? ''))?.name,
    ).toBe('Acme Tools');
    expect((await source.get(model(CUSTOMER), id))?.status).toBe('suspended');
  });

  it('edits a seeded customer through its seeded profile', async () => {
    const source = fresh();
    const active = customerForm();
    const [first] = await source.list(model(CUSTOMER));
    const id = first?.id ?? '';
    const rows = await findFieldMapRows(source, active, catalogModels, id);
    expect(rows.profile?.id).toBe(first?.profileId);
    const loaded = await loadFieldMap(source, active, catalogModels, id);
    expect(loaded.name).toBe(rows.profile?.name);
  });

  it('stores an Address as an object, not null', async () => {
    const source = fresh();
    const active = customerForm();
    const address = { street1: '1 Main St', city: 'Calgary', state: 'AB' };
    const saved = await source.apply(
      planFieldMapSave(active, catalogModels, {
        ...blankFieldMap(active, catalogModels),
        name: 'Addressed',
        shippingAddress: address,
      }),
    );
    expect(saved.customer?.defaultShippingAddress).toEqual(address);
  });

  it('saves a Vendor the same way', async () => {
    const source = fresh();
    const active = vendorForm();
    const saved = await source.apply(
      planFieldMapSave(active, catalogModels, {
        ...blankFieldMap(active, catalogModels),
        name: 'Cedar Supply',
        email: 'sales@cedar.example',
        minimumOrderAmount: 5000,
      }),
    );
    expect(saved.profile).toMatchObject({ name: 'Cedar Supply' });
    expect(saved.vendor).toMatchObject({
      profileId: saved.profile?.id,
      status: 'active',
      currency: 'USD',
      minimumOrderAmount: 5000,
    });
    expect(saved.profileType?.name).toBe('Vendor');
  });
});

describe('seeded sample data lines up', () => {
  it('points every customer and vendor at an existing, different profile', async () => {
    const source = createMemoryDataSource();
    const profiles = new Map(
      (await source.list(model(PROFILE))).map((p) => [p.id, p]),
    );
    const customers = await source.list(model(CUSTOMER));
    const vendors = await source.list(model(VENDOR));
    for (const row of [...customers, ...vendors]) {
      expect(profiles.has(String(row.profileId))).toBe(true);
    }
    const customerProfiles = new Set(customers.map((c) => c.profileId));
    for (const vendor of vendors) {
      expect(customerProfiles.has(vendor.profileId)).toBe(false);
    }
  });

  it('points orders at existing customers and fills enums with real values', async () => {
    const source = createMemoryDataSource();
    const customers = new Set(
      (await source.list(model(CUSTOMER))).map((c) => c.id),
    );
    const statuses = field(ORDER, 'status').enum ?? [];
    for (const order of await source.list(model(ORDER))) {
      expect(customers.has(String(order.customerId))).toBe(true);
      expect(statuses).toContain(order.status);
    }
  });
});

describe('labels instead of ids', () => {
  it("labels an Order's customer with the customer's profile name", async () => {
    const source = createMemoryDataSource();
    const orders = await source.list(model(ORDER));
    const customerId = field(ORDER, 'customerId');
    const labels = await relationLabels(source, [customerId], orders);
    const customers = await source.list(model(CUSTOMER));
    const profiles = await source.list(model(PROFILE));
    for (const order of orders) {
      const customer = customers.find((c) => c.id === order.customerId);
      const profile = profiles.find((p) => p.id === customer?.profileId);
      const text = formatValue(customerId, order.customerId, labels);
      expect(text).toBe(profile?.name);
      expect(text).not.toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('shows the customer name column on the Customer list', async () => {
    const source = createMemoryDataSource();
    const customers = await source.list(model(CUSTOMER));
    const profileId = field(CUSTOMER, 'profileId');
    const labels = await relationLabels(source, [profileId], customers);
    for (const customer of customers) {
      const profile = await source.get(
        model(PROFILE),
        String(customer.profileId),
      );
      expect(formatValue(profileId, customer.profileId, labels)).toBe(
        profile?.name,
      );
    }
  });

  it('falls back to a short id only when the record is gone', () => {
    const customerId = field(ORDER, 'customerId');
    const gone = '0123456789abcdef';
    expect(formatValue(customerId, gone, new Map())).toBe('01234567');
    expect(
      formatValue(
        customerId,
        gone,
        new Map([[labelKey(CUSTOMER, gone), 'Acme']]),
      ),
    ).toBe('Acme');
  });

  it('labels a generic record by its display field', async () => {
    const source = createMemoryDataSource();
    const [location] = await source.list(
      model('@happyvertical/smrt-inventory:InventoryLocation'),
    );
    expect(
      await recordLabel(
        source,
        model('@happyvertical/smrt-inventory:InventoryLocation'),
        location ?? { id: 'x' },
      ),
    ).toBe(location?.name);
  });
});

describe('relation searches run against the DataSource', () => {
  it('finds customers by profile name, joined to their profile', async () => {
    const source = createMemoryDataSource();
    const all = await searchCustomers(source, '');
    expect(all.length).toBeGreaterThan(0);
    const target = all[0];
    if (!target) throw new Error('no customers');
    const found = await searchCustomers(
      source,
      target.profile.name.slice(1, 5).toUpperCase(),
    );
    expect(found.map((c) => c.id)).toContain(target.id);
    expect(await searchCustomers(source, 'zzzz-no-such-name')).toEqual([]);
    expect(await resolveCustomer(source, target.id)).toMatchObject({
      id: target.id,
      profile: { name: target.profile.name },
    });
    expect(await resolveCustomer(source, 'missing')).toBeNull();
  });

  it('shows the profile name plus status and type', async () => {
    const source = createMemoryDataSource();
    const [customer] = await searchCustomers(source, '');
    if (!customer) throw new Error('no customers');
    const option = customerOption(customer);
    expect(option.label).toBe(customer.profile.name);
    expect(option.detail).toBe(`${customer.status} · ${customer.customerType}`);
  });

  it('finds vendors, and a new customer appears in the next search', async () => {
    const source = createMemoryDataSource();
    expect((await searchVendors(source, '')).length).toBeGreaterThan(0);
    const form = activeForms(['commerce.customers'], recipes, CUSTOMER).find(
      isFieldMap,
    );
    if (!form) throw new Error('no form');
    await source.apply(
      planFieldMapSave(form, catalogModels, {
        ...blankFieldMap(form, catalogModels),
        name: 'Zebra Outfitters',
      }),
    );
    const found = await searchCustomers(source, 'zebra');
    expect(found).toHaveLength(1);
    expect(found[0]?.profile.name).toBe('Zebra Outfitters');
  });

  it('searches any other target by its display label', async () => {
    const source = createMemoryDataSource();
    const location = model('@happyvertical/smrt-inventory:InventoryLocation');
    const [first] = await source.list(location);
    const hits = await searchRelated(source, location, String(first?.name));
    expect(hits.map((h) => h.id)).toContain(first?.id);
  });
});

describe('Address conversion for AddressInput', () => {
  it('round-trips the stored shape and keeps street2', () => {
    const stored = {
      street1: '1 Main St',
      street2: 'Unit 4',
      city: 'Seattle',
      state: 'WA',
      postalCode: '98101',
      country: 'US',
    };
    const input = toAddressInput(stored);
    expect(input).toEqual({
      street: '1 Main St',
      city: 'Seattle',
      province: 'US-WA',
      postalCode: '98101',
      country: 'US',
    });
    expect(fromAddressInput(input, stored)).toEqual(stored);
  });

  it('drops emptied parts and tolerates a missing value', () => {
    expect(toAddressInput(null)).toEqual({});
    expect(
      fromAddressInput({ city: 'Calgary', street: '' }, undefined),
    ).toEqual({
      city: 'Calgary',
    });
    expect(fromAddressInput({ province: 'AB' }, { state: 'ON' })).toEqual({
      state: 'AB',
    });
  });
});
