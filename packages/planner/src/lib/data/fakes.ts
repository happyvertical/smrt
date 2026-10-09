import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { isLineModel } from './derived.ts';
import {
  GENERIC_PACK,
  getSamplePack,
  getSampleTaxRate,
  type PackLine,
  type SamplePack,
} from './packs.ts';

/** A row of sample data. `id` is always present. */
export interface ModelRecord {
  id: string;
  [field: string]: unknown;
}

/** Deterministic PRNG (mulberry32): the same seed always yields the same run. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string, for seeding. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const MONEY_NAME =
  /(price|amount|cost|total|balance|fee|tax|revenue|budget|salary|wage|subtotal|discount|spend|payout|commission|credit|debit|charge|refund|fare|rent)/i;
const NOT_MONEY_NAME = /(count|quantity|qty|percent|ratio|level)/i;

/**
 * Money is stored as integer minor units (cents). A field is money when it is
 * an integer whose name says so; everything else numeric is a plain number.
 */
export function isMoneyField(field: CatalogField): boolean {
  return (
    field.type === 'integer' &&
    MONEY_NAME.test(field.name) &&
    !NOT_MONEY_NAME.test(field.name)
  );
}

const WORDS = [
  'Harbor',
  'Maple',
  'Summit',
  'Cedar',
  'Willow',
  'Copper',
  'Juniper',
  'Atlas',
  'Meadow',
  'Granite',
  'Lantern',
  'Orchard',
  'Saffron',
  'Timber',
  'Velvet',
  'Beacon',
];
const NOUNS = [
  'Goods',
  'Supply',
  'Studio',
  'Works',
  'Market',
  'Collective',
  'Trading',
  'Labs',
];
/**
 * Things a shop sells, with a price in cents. Sample products and SKUs take
 * their names from here by row index, and a line item pointing at product `n`
 * reads as that product, so a picked product and a sample line agree.
 */
export const PRODUCT_CATALOG: readonly { name: string; price: number }[] =
  GENERIC_PACK.products;

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Mae', 'Jun', 'Priya', 'Omar'];
const LAST = ['Nguyen', 'Garcia', 'Okafor', 'Silva', 'Kim', 'Haddad', 'Rossi'];
const SENTENCES = [
  'Reviewed and approved by the team.',
  'Waiting on a reply from the customer.',
  'Imported from the previous system.',
  'Scheduled for the next cycle.',
  'Flagged for follow-up next week.',
];

/** Fixed clock so seeded timestamps never change between runs. */
export const EPOCH = Date.UTC(2026, 0, 1);
const YEAR = 365 * 24 * 60 * 60 * 1000;

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

/** Pick by weight; values without a weight count 0, and all-zero falls back to uniform. */
function pickWeighted(
  random: () => number,
  values: readonly string[],
  weights: Readonly<Record<string, number>>,
): string {
  const total = values.reduce((sum, v) => sum + (weights[v] ?? 0), 0);
  if (total <= 0) return pick(random, values);
  let at = random() * total;
  for (const value of values) {
    at -= weights[value] ?? 0;
    if (at < 0) return value;
  }
  return values[values.length - 1] as string;
}

/** A UUID-shaped id derived from a seed string. */
export function fakeId(seed: string): string {
  const random = createRandom(hashString(seed));
  const hex = (n: number) =>
    Array.from({ length: n }, () =>
      Math.floor(random() * 16).toString(16),
    ).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

const TERMS = [
  'Net 30',
  'Net 15',
  'Net 60',
  'Due on receipt',
  '50% deposit, balance on delivery',
];
const CHANNELS = ['web', 'retail', 'phone', 'marketplace', 'wholesale'];
const PERIODS = ['monthly', 'quarterly', 'annual'];

/** Fractions a tax rate takes: 0%, 5%, 8.25%, 13% and 20%. */
export const TAX_RATES = [0, 0.05, 0.0825, 0.13, 0.2] as const;

function fakeText(
  field: CatalogField,
  random: () => number,
  modelName = '',
): string {
  const name = field.name.toLowerCase();
  if (/terms/.test(name)) return pick(random, getSamplePack().terms ?? TERMS);
  if (/channel/.test(name)) return pick(random, CHANNELS);
  if (/period/.test(name)) return pick(random, PERIODS);
  if (/^(unit|uom)$/.test(name)) return pick(random, ['each', 'hour', 'box']);
  if (/email/.test(name)) {
    return `${pick(random, FIRST).toLowerCase()}@example.com`;
  }
  if (/(^|_)(url|link|website|href)/.test(name) || /url$/.test(name)) {
    return `https://example.com/${pick(random, WORDS).toLowerCase()}`;
  }
  if (/phone/.test(name)) {
    return `+1-555-01${Math.floor(random() * 90 + 10)}`;
  }
  // Notes are about a person or a job; a description says what a thing is.
  // Each has its own vocabulary: a class is never described by a member's note.
  if (/(notes?|comment|message)/.test(name)) {
    const pack = getSamplePack();
    const own =
      modelName === 'Customer'
        ? pack.customerNotes
        : modelName === 'Vendor'
          ? pack.vendorNotes
          : undefined;
    return pick(random, own ?? pack.notes ?? SENTENCES);
  }
  if (/(description|summary|body|content|bio)/.test(name)) {
    return pick(random, getSamplePack().descriptions?.[modelName] ?? SENTENCES);
  }
  if (/(firstname|first_name)/.test(name)) return pick(random, FIRST);
  if (/(lastname|last_name|surname)/.test(name)) return pick(random, LAST);
  // Tax and business registration numbers are identifiers, never names.
  if (/(tax_?id|vat|^ein$|abn|gst|registration)/.test(name)) {
    return `${Math.floor(random() * 90 + 10)}-${Math.floor(random() * 9_000_000 + 1_000_000)}`;
  }
  if (/(code|sku|barcode|number|reference)/.test(name)) {
    return `${pick(random, WORDS).slice(0, 3).toUpperCase()}-${Math.floor(random() * 9000 + 1000)}`;
  }
  if (/(status|state|stage)/.test(name)) {
    return pick(random, ['active', 'pending', 'archived', 'draft']);
  }
  if (/(currency)/.test(name)) return 'USD';
  if (/(person|owner|author|contact|assignee|worker)/.test(name)) {
    return `${pick(random, FIRST)} ${pick(random, LAST)}`;
  }
  return `${pick(random, WORDS)} ${pick(random, NOUNS)}`;
}

/**
 * Sample rows per model where the default count does not fit: every Customer
 * and Vendor gets its own Profile, so the lists show different names.
 * Customers use Profiles 0-7, Vendors 8-12 and the pack's instructors 13 on
 * (`sampleRowCount` adds them).
 */
const PROFILE_MODEL = '@happyvertical/smrt-profiles:Profile';

export const SAMPLE_ROW_COUNTS: Readonly<Record<string, number>> = {
  '@happyvertical/smrt-profiles:Profile': 13,
  '@happyvertical/smrt-commerce:Vendor': 5,
};

/** Sample rows for a model: the pack's count, else the shared one, else `fallback`. */
export function sampleRowCount(modelId: string, fallback: number): number {
  // Profiles: customers, then vendors, then the pack's instructors.
  if (modelId === PROFILE_MODEL) {
    return (
      (getSamplePack().rowCounts?.[modelId] ??
        SAMPLE_ROW_COUNTS[modelId] ??
        fallback) + (getSamplePack().instructors?.length ?? 0)
    );
  }
  return (
    getSamplePack().rowCounts?.[modelId] ??
    SAMPLE_ROW_COUNTS[modelId] ??
    fallback
  );
}

/**
 * Which row of the target a sample relation points at. Rows are seeded with
 * ids from `(model, index)`, so pointing at index `n` points at a real row.
 */
function relatedIndex(
  field: CatalogField,
  context: { modelId: string; index: number },
): number {
  const instructors = getSamplePack().instructors;
  if (field.name === 'organizerId' && instructors?.length) {
    // Organizers lead classes and jobs; they are staff, never customers.
    return 13 + (context.index % instructors.length);
  }
  if (field.name === 'profileId') {
    if (context.modelId.endsWith(':Vendor')) return 8 + (context.index % 5);
    // Sign-ups and the like point at a customer's Profile, whatever their
    // own row index (child rows are numbered up to 996).
    return context.modelId.endsWith(':Customer')
      ? context.index
      : context.index % 8;
  }
  return context.index % 5;
}

/** One fake value for a field. Money is an integer number of minor units. */
export function fakeValue(
  field: CatalogField,
  random: () => number,
  context: { modelId: string; index: number },
): unknown {
  // A declared enumeration: only its values are valid.
  if (field.enum && field.enum.length > 0) {
    const weights =
      getSamplePack().weights?.[
        `${context.modelId.split(':').pop()}.${field.name}`
      ];
    return weights
      ? pickWeighted(random, field.enum, weights)
      : pick(random, field.enum);
  }
  switch (field.type) {
    case 'boolean':
      return random() < 0.7;
    case 'integer': {
      if (isMoneyField(field)) return (Math.floor(random() * 4950) + 50) * 10;
      if (/(quantity|qty|count|stock|on_?hand)/i.test(field.name)) {
        return Math.floor(random() * 200);
      }
      if (/(level|sortorder|position|order)/i.test(field.name)) {
        return Math.floor(random() * 5);
      }
      return Math.floor(random() * 100);
    }
    case 'decimal':
      if (/taxrate|vatrate/i.test(field.name)) {
        // A cookbook's default rate (0: untaxed) beats a random one.
        const rate = getSampleTaxRate();
        return rate ?? pick(random, TAX_RATES);
      }
      if (/discountrate/i.test(field.name)) return pick(random, [0, 0.05, 0.1]);
      if (/(quantity|qty)/i.test(field.name))
        return 1 + Math.floor(random() * 5);
      return Math.round(random() * 10000) / 100;
    case 'datetime':
      return new Date(EPOCH - Math.floor(random() * YEAR)).toISOString();
    case 'json':
      return Array.isArray(field.default) ? [] : {};
    case 'foreignKey':
    case 'crossPackageRef':
      return fakeId(
        `${field.related ?? field.name}:${relatedIndex(field, context)}`,
      );
    default:
      return fakeText(field, random, context.modelId.split(':').pop());
  }
}

/** Fields a person edits: everything the framework does not manage. */
export function editableFields(model: CatalogModel): CatalogField[] {
  return model.fields.filter((f) => !f.system);
}

export const DAY = 24 * 60 * 60 * 1000;

/**
 * Where a date field sits in a record's timeline, by its name: it begins
 * (created, issued, start), something happens to it (updated, paid, shipped:
 * never in the future), it falls due, then it ends (expiry, end).
 */
type DateStage = 'start' | 'event' | 'due' | 'end';

function dateStage(name: string): DateStage | null {
  const n = name.toLowerCase();
  if (/^last/.test(n)) return null;
  if (
    /(expir|enddate|endat|endsat|endedat|ends|until|closed|cancel|periodend|effectiveto|windowend|trialends|void|revoked)/.test(
      n,
    )
  )
    return 'end';
  if (/(due|deadline|schedul|renew|nextrun|estimated|expected|payable)/.test(n))
    return 'due';
  if (
    /(updated|modified|paid|ship|deliver|settled|resolved|completed|approved|confirmed|received|accepted|reviewed|verified|published|posted|viewed|decided|finalized)/.test(
      n,
    )
  )
    return 'event';
  if (
    /(issue|startdate|startat|startsat|startedat|periodstart|effectivedate|effectivefrom|windowstart|sentat|occurredat|requestedat|submittedat|^date$|^timestamp$|publish_date|balancefrom)/.test(
      n,
    )
  )
    return 'start';
  return null;
}

/**
 * Makes a record's dates agree with each other: issued/start first, then what
 * happens to it, then due, then expiry/end. Deterministic, as every offset
 * comes from the record's own random stream.
 */
function orderDates(
  model: CatalogModel,
  record: ModelRecord,
  random: () => number,
): void {
  const dated = model.fields
    .filter((f) => !f.system && f.type === 'datetime' && !f.enum)
    .flatMap((field) => {
      const stage = dateStage(field.name);
      return stage ? [{ field, stage }] : [];
    });
  if (dated.length === 0) return;
  const first = dated.find((d) => d.stage === 'start');
  const anchor = first
    ? Date.parse(String(record[first.field.name]))
    : EPOCH - Math.floor(random() * YEAR);
  const event = Math.min(anchor + (1 + Math.floor(random() * 20)) * DAY, EPOCH);
  const due = Math.max(event, anchor) + (14 + Math.floor(random() * 32)) * DAY;
  const end = due + (30 + Math.floor(random() * 150)) * DAY;
  const at = { start: anchor, event, due, end };
  for (const { field, stage } of dated) {
    record[field.name] = new Date(at[stage]).toISOString();
  }
}

const has = (model: CatalogModel, name: string) =>
  model.fields.some((f) => f.name === name);

/**
 * Products and SKUs are called things ("Canvas tote"), not companies, and a
 * line item describes the item it sells rather than quoting a status.
 */
function nameThings(
  model: CatalogModel,
  record: ModelRecord,
  index: number,
  random: () => number,
): void {
  // Most payments went through; the rest are pending, failed or refunded.
  const status = model.fields.find((f) => f.name === 'status');
  if (
    model.id.endsWith(':Payment') &&
    status?.enum?.includes('completed') &&
    random() < 0.6
  ) {
    record.status = 'completed';
  }
  const pack = getSamplePack();
  nameFromPack(model, record, index, pack);
  const item = pack.products[index % pack.products.length];
  if (!item) return;
  if (/:(Product|Sku)$/.test(model.id)) {
    if (has(model, 'name')) record.name = item.name;
    if (has(model, 'price')) record.price = item.price;
    if (model.id.endsWith(':Product')) {
      if (has(model, 'description')) {
        // The generic template belongs to the generic pack only.
        const fallback =
          pack.id === GENERIC_PACK.id
            ? `${item.name}, made in small batches.`
            : item.name;
        record.description = item.description ?? fallback;
      }
      if (item.category && has(model, 'category')) {
        record.category = item.category;
      }
      if (item.productType && has(model, 'productType')) {
        record.productType = item.productType;
      }
    }
    return;
  }
  if (isLineModel(model) && has(model, 'description')) {
    const lines =
      pack.lines ?? pack.products.map((p) => ({ description: p.name }));
    const line = lines[Math.floor(random() * lines.length)];
    if (line) record.description = line.description;
  }
}

/**
 * Names a pack supplies for whole models: customers and vendors (their
 * Profiles), events and their types and series, places and their types. Packs without them leave the
 * generic words in place.
 */
function nameFromPack(
  model: CatalogModel,
  record: ModelRecord,
  index: number,
  pack: SamplePack,
): void {
  const at = <T>(list: readonly T[] | undefined, i: number): T | undefined =>
    list?.length ? list[i % list.length] : undefined;
  if (model.id.endsWith(':Profile') && has(model, 'name')) {
    // Customers use Profiles 0-7, Vendors 8-12, instructors 13 on (see
    // SAMPLE_ROW_COUNTS).
    const name =
      index < 8
        ? at(pack.customers, index)
        : index < 13
          ? at(pack.vendors, index - 8)
          : at(pack.instructors, index - 13);
    if (name) {
      record.name = name;
      if (has(model, 'email')) {
        const local = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '.')
          .replace(/^\.+|\.+$/g, '');
        record.email = `${local}@example.com`;
      }
    }
    return;
  }
  const short = model.id.split(':').pop() ?? '';
  if (short === 'EventParticipant') {
    // A sign-up points at a member's Profile; every fifth is the instructor.
    const instructors = pack.instructors;
    const teaches = Boolean(instructors?.length) && index % 5 === 0;
    if (has(model, 'profileId')) {
      record.profileId = fakeId(
        `${PROFILE_MODEL}:${
          teaches && instructors
            ? 13 + (Math.floor(index / 5) % instructors.length)
            : index % 8
        }`,
      );
    }
    if (has(model, 'role')) record.role = teaches ? 'instructor' : 'attendee';
    return;
  }
  if (has(model, 'allDay') && typeof record.startDate === 'string') {
    // Events happen at a time of day: on the hour, between 6 and 20 h, for an hour.
    const day =
      Date.parse(record.startDate) - (Date.parse(record.startDate) % DAY);
    const start = day + (6 + (index % 15)) * 60 * 60 * 1000;
    record.startDate = new Date(start).toISOString();
    if (has(model, 'endDate')) {
      record.endDate = new Date(start + 60 * 60 * 1000).toISOString();
    }
  }
  const names: Record<string, readonly string[] | undefined> = {
    Event: pack.eventNames,
    EventType: pack.eventTypes,
    EventSeries: pack.seriesNames,
    Place: pack.placeNames,
    PlaceType: pack.placeTypes,
  };
  const list = names[short];
  const name = at(list, index);
  if (name && has(model, 'name')) record.name = name;
  // A description list lines up with the names: entry n describes name n.
  const description = at(pack.descriptions?.[short], index);
  if (description && list && has(model, 'description')) {
    record.description = description;
  }
}

/**
 * The line a sample line item reads as when the pack describes lines apart
 * from products (labour, fabrication, passes); `undefined` for packs whose
 * lines are their products.
 */
export function packLine(index: number): PackLine | undefined {
  const lines = getSamplePack().lines;
  return lines?.length ? lines[index % lines.length] : undefined;
}

/** A single seeded record for a model. */
export function fakeRecord(
  model: CatalogModel,
  index: number,
  seed: number,
): ModelRecord {
  const random = createRandom(hashString(`${seed}:${model.id}:${index}`));
  const record: ModelRecord = { id: fakeId(`${model.id}:${index}`) };
  for (const field of model.fields) {
    if (field.system) continue;
    record[field.name] = fakeValue(field, random, {
      modelId: model.id,
      index,
    });
  }
  orderDates(
    model,
    record,
    createRandom(hashString(`${seed}:${model.id}:${index}:dates`)),
  );
  nameThings(model, record, index, random);
  return record;
}

/** `count` seeded records for a model. */
export function fakeRecords(
  model: CatalogModel,
  count: number,
  seed = 1,
): ModelRecord[] {
  return Array.from({ length: count }, (_, i) => fakeRecord(model, i, seed));
}
