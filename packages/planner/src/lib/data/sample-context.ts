import { workspaceStorage } from '../planner/workspace-storage.ts';
/** Fictional vocabulary for a custom app's demo records; never cookbook data. */
export interface SampleContext {
  provenance: 'fictional';
  products: {
    name: string;
    description: string;
    price: number;
    category?: string;
  }[];
  customers: string[];
  vendors: string[];
}

const text = { type: 'string', minLength: 1, maxLength: 160 };
export const sampleContextSchema = {
  type: 'object',
  properties: {
    provenance: { enum: ['fictional'] },
    products: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          name: text,
          description: { ...text, maxLength: 400 },
          price: { type: 'integer', minimum: 0, maximum: 1000000000 },
          category: text,
        },
        required: ['name', 'description', 'price'],
        additionalProperties: false,
      },
    },
    customers: { type: 'array', minItems: 1, maxItems: 8, items: text },
    vendors: { type: 'array', minItems: 1, maxItems: 5, items: text },
  },
  required: ['provenance', 'products', 'customers', 'vendors'],
  additionalProperties: false,
} as const;

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const words = (v: unknown, max = 160): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
/** Reject the entire vocabulary when any part is invalid. */
export function parseSampleContext(value: unknown): SampleContext | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) => !['provenance', 'products', 'customers', 'vendors'].includes(k),
    ) ||
    value.provenance !== 'fictional'
  )
    return;
  const names = (v: unknown, max: number): v is string[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= max &&
    v.every((n) => words(n));
  if (
    !names(value.customers, 8) ||
    !names(value.vendors, 5) ||
    !Array.isArray(value.products) ||
    !value.products.length ||
    value.products.length > 16
  )
    return;
  for (const p of value.products) {
    if (
      !object(p) ||
      Object.keys(p).some(
        (k) => !['name', 'description', 'price', 'category'].includes(k),
      ) ||
      !words(p.name) ||
      !words(p.description, 400) ||
      typeof p.price !== 'number' ||
      !Number.isSafeInteger(p.price) ||
      p.price < 0 ||
      p.price > 1000000000 ||
      (p.category !== undefined && !words(p.category))
    )
      return;
  }
  return JSON.parse(JSON.stringify(value)) as SampleContext;
}

export const SAMPLE_CONTEXT_KEY = 'smrt-planner:sample-context:v1';
let active: SampleContext | undefined;
function storage(): Storage | null {
  try {
    return workspaceStorage();
  } catch {
    return null;
  }
}
/** Read before generating rows, including a direct record-page reload. */
export function getSampleContext(): SampleContext | undefined {
  if (!active) {
    try {
      active = parseSampleContext(
        JSON.parse(storage()?.getItem(SAMPLE_CONTEXT_KEY) ?? 'null'),
      );
    } catch {
      /* Unreadable context never replaces records. */
    }
  }
  return active;
}
/** Install once. Retries and feature followups never replace vocabulary or rows. */
export function applySampleContext(value: unknown): boolean {
  const context = parseSampleContext(value);
  if (!context || getSampleContext()) return false;
  active = context;
  try {
    storage()?.setItem(SAMPLE_CONTEXT_KEY, JSON.stringify(context));
  } catch {
    /* In-memory previews still work without browser storage. */
  }
  return true;
}

/** Explicit full data reset starts a new demo context, matching the data source's origin scope. */
export function clearSampleContext(): void {
  active = undefined;
  try {
    storage()?.removeItem(SAMPLE_CONTEXT_KEY);
  } catch {
    /* Storage may be unavailable. */
  }
}
