import type { MessagingProviderField } from '../providers.js';

export function coerceMessagingProviderValues(
  values: Record<string, string>,
  fields: MessagingProviderField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined || value === '') continue;
    if (field.type === 'number') result[field.id] = Number(value);
    else if (field.type === 'boolean') result[field.id] = value === 'true';
    else result[field.id] = value;
  }
  return result;
}
