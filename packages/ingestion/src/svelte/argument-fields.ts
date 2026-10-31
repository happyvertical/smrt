import type { ProposalCatalogEntry } from '../proposal-dto.js';

/** One top-level handler argument the review screen can edit as a field. */
export type ArgumentField =
  | {
      name: string;
      title: string;
      required: boolean;
      kind: 'text' | 'date' | 'date-time';
      maxLength?: number;
    }
  | {
      name: string;
      title: string;
      required: boolean;
      kind: 'number' | 'integer';
      minimum?: number;
      maximum?: number;
    }
  | { name: string; title: string; required: boolean; kind: 'boolean' }
  | {
      name: string;
      title: string;
      required: boolean;
      kind: 'enum';
      options: Array<string | number>;
    }
  | {
      name: string;
      title: string;
      required: boolean;
      kind: 'candidate';
      model: string;
    }
  | { name: string; title: string; required: boolean; kind: 'evidence' };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** The single non-null JSON type a property declares, if any. */
function typeOf(schema: Record<string, unknown>): string | undefined {
  const declared = schema.type;
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared)) {
    const types = declared.filter((type) => type !== 'null');
    return types.length === 1 && typeof types[0] === 'string'
      ? types[0]
      : undefined;
  }
  return undefined;
}
/**
 * Top-level arguments drawn as fields (#4503): strings (plain, `date`,
 * `date-time`), numbers, integers, booleans, enums of strings or numbers, and
 * declared candidate/evidence references. Anything else (objects, arrays,
 * unions) is edited only as JSON under "Advanced".
 */
export function argumentFields(
  schema: Record<string, unknown> | undefined,
  references: ProposalCatalogEntry['references'] = {},
): ArgumentField[] {
  const root = record(schema);
  const properties = record(root.properties);
  const required = new Set(
    Array.isArray(root.required)
      ? root.required.filter((name) => typeof name === 'string')
      : [],
  );
  const fields: ArgumentField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = record(value);
    const base = {
      name,
      title:
        typeof property.title === 'string' && property.title.trim()
          ? property.title.trim()
          : name,
      required: required.has(name),
    };
    const reference = references[name];
    if (reference?.kind === 'candidate') {
      fields.push({ ...base, kind: 'candidate', model: reference.model });
      continue;
    }
    if (reference?.kind === 'evidence') {
      fields.push({ ...base, kind: 'evidence' });
      continue;
    }
    const type = typeOf(property);
    if (
      Array.isArray(property.enum) &&
      property.enum.length &&
      property.enum.every(
        (option) => typeof option === 'string' || typeof option === 'number',
      )
    ) {
      fields.push({
        ...base,
        kind: 'enum',
        options: property.enum as Array<string | number>,
      });
      continue;
    }
    if (type === 'string')
      fields.push({
        ...base,
        kind:
          property.format === 'date'
            ? 'date'
            : property.format === 'date-time'
              ? 'date-time'
              : 'text',
        ...(Number.isSafeInteger(property.maxLength)
          ? { maxLength: property.maxLength as number }
          : {}),
      });
    else if (type === 'number' || type === 'integer')
      fields.push({
        ...base,
        kind: type,
        ...(typeof property.minimum === 'number'
          ? { minimum: property.minimum }
          : {}),
        ...(typeof property.maximum === 'number'
          ? { maximum: property.maximum }
          : {}),
      });
    else if (type === 'boolean') fields.push({ ...base, kind: 'boolean' });
  }
  return fields;
}
/** `YYYY-MM-DDTHH:mm` in local time for a `datetime-local` input; '' when unparsable. */
export function localDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
