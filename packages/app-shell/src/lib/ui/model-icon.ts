// A stable sidebar icon per model. Names are smrt-svelte's built-in shell
// icons (`SHELL_ICON_PATHS`); nothing here depends on the browser.
import type { FieldDef } from './types.ts';

const KEYWORDS: readonly [icon: string, words: readonly string[]][] = [
  [
    'users',
    [
      'client',
      'customer',
      'contact',
      'person',
      'people',
      'member',
      'user',
      'employee',
      'staff',
      'student',
      'patient',
      'owner',
      'team',
    ],
  ],
  ['receipt', ['invoice', 'receipt', 'bill', 'payment', 'expense']],
  ['tag', ['rate', 'price', 'pricing', 'fee', 'tariff', 'discount']],
  [
    'calendar',
    [
      'walk',
      'event',
      'appointment',
      'booking',
      'visit',
      'schedule',
      'shift',
      'session',
      'meeting',
      'reservation',
    ],
  ],
  ['truck', ['delivery', 'shipment', 'vehicle', 'route', 'order']],
  ['package', ['product', 'item', 'inventory', 'stock', 'part', 'supply']],
  ['shoppingBag', ['sale', 'cart', 'purchase', 'shop']],
  ['wrench', ['job', 'task', 'repair', 'service', 'maintenance', 'ticket']],
  ['briefcase', ['project', 'company', 'vendor', 'supplier', 'business']],
  ['fileText', ['note', 'document', 'doc', 'report', 'contract', 'letter']],
  ['bank', ['account', 'bank', 'ledger', 'budget']],
  ['repeat', ['subscription', 'recurring', 'routine', 'habit', 'chore']],
  ['book', ['book', 'course', 'lesson', 'recipe', 'journal']],
];

/** Neutral icons for names no keyword claims; chosen by a stable hash. */
export const FALLBACK_ICONS: readonly string[] = [
  'folder',
  'layers',
  'archive',
  'package',
  'fileText',
  'briefcase',
  'book',
];

/** Lowercase word pieces of a model name (`DogWalk`, `dog_walks`, `Dog walk`). */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fromName(name: string): string | null {
  const parts = words(name);
  for (const [icon, list] of KEYWORDS)
    if (parts.some((p) => list.includes(p))) return icon;
  return null;
}

function fromFields(fields: Record<string, FieldDef>): string | null {
  const defs = Object.values(fields);
  if (defs.some((f) => f.money)) return 'tag';
  if (defs.some((f) => f.type === 'date')) return 'calendar';
  return null;
}

/**
 * The icon for one model: a keyword in its name, else a hint from its fields
 * (money, dates), else a stable pick from a small neutral palette by name.
 * Same input, same icon, every time.
 */
export function modelIcon(
  name: string,
  fields: Record<string, FieldDef> = {},
): string {
  return (
    fromName(name) ??
    fromFields(fields) ??
    FALLBACK_ICONS[hash(name) % FALLBACK_ICONS.length]
  );
}

/** Every icon a model may get, preferred ones first (the order is the tie-break). */
const ALL_ICONS: readonly string[] = [
  ...KEYWORDS.map(([icon]) => icon),
  ...FALLBACK_ICONS,
  'creditCard',
  'school',
  'layers',
];

/** Close second choices, tried when a model's own icon is already taken. */
const ALTERNATES: Record<string, readonly string[]> = {
  users: ['creditCard', 'school', 'briefcase'],
  receipt: ['creditCard', 'fileText', 'bank'],
  calendar: ['repeat', 'book'],
  truck: ['package', 'shoppingBag'],
  package: ['archive', 'layers'],
  shoppingBag: ['creditCard', 'package'],
  tag: ['creditCard', 'bank'],
  wrench: ['briefcase', 'repeat'],
  briefcase: ['layers', 'folder'],
  fileText: ['book', 'archive'],
  bank: ['creditCard', 'briefcase'],
};

/**
 * Icons for a whole menu: each model's own pick, but two models never share
 * one while an unused icon is left (Clients and Customers both read "users").
 * Models are settled in name order, so the result does not depend on the order
 * they were declared in and an earlier name never loses its icon to a later one.
 */
export function modelIcons(
  models: Record<string, { fields?: Record<string, FieldDef> }>,
): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const name of Object.keys(models).sort()) {
    const wanted = modelIcon(name, models[name].fields);
    const start = hash(name);
    const spare = [...new Set(ALL_ICONS)].filter((i) => !used.has(i));
    const close = (ALTERNATES[wanted] ?? []).find((i) => !used.has(i));
    const pick = used.has(wanted)
      ? (close ?? (spare.length ? spare[start % spare.length] : wanted))
      : wanted;
    used.add(pick);
    out[name] = pick;
  }
  return out;
}
