import type { CatalogField, CatalogModel } from '../catalog/types.ts';

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
const EPOCH = Date.UTC(2026, 0, 1);
const YEAR = 365 * 24 * 60 * 60 * 1000;

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
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

function fakeText(field: CatalogField, random: () => number): string {
  const name = field.name.toLowerCase();
  if (/email/.test(name)) {
    return `${pick(random, FIRST).toLowerCase()}@example.com`;
  }
  if (/(^|_)(url|link|website|href)/.test(name) || /url$/.test(name)) {
    return `https://example.com/${pick(random, WORDS).toLowerCase()}`;
  }
  if (/phone/.test(name)) {
    return `+1-555-01${Math.floor(random() * 90 + 10)}`;
  }
  if (
    /(description|summary|body|notes?|content|comment|message|bio)/.test(name)
  ) {
    return pick(random, SENTENCES);
  }
  if (/(firstname|first_name)/.test(name)) return pick(random, FIRST);
  if (/(lastname|last_name|surname)/.test(name)) return pick(random, LAST);
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

/** One fake value for a field. Money is an integer number of minor units. */
export function fakeValue(
  field: CatalogField,
  random: () => number,
  context: { modelId: string; index: number },
): unknown {
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
      return Math.round(random() * 10000) / 100;
    case 'datetime':
      return new Date(EPOCH - Math.floor(random() * YEAR)).toISOString();
    case 'json':
      return Array.isArray(field.default) ? [] : {};
    case 'foreignKey':
    case 'crossPackageRef':
      return fakeId(`${field.related ?? field.name}:${context.index % 5}`);
    default:
      return fakeText(field, random);
  }
}

/** Fields a person edits: everything the framework does not manage. */
export function editableFields(model: CatalogModel): CatalogField[] {
  return model.fields.filter((f) => !f.system);
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
