import pluralizeLib from 'pluralize';

/**
 * Converts a camelCase string to snake_case.
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Pluralizes an English word using the pluralize library.
 *
 * For snake_case table names with multiple words, only the last word is
 * pluralized: `journal_entry` -> `journal_entries`.
 */
export function pluralize(word: string): string {
  if (word.includes('_')) {
    const parts = word.split('_');
    const lastWord = parts.pop();
    if (!lastWord) return word;
    return [...parts, pluralizeLib(lastWord)].join('_');
  }

  return pluralizeLib(word);
}

/**
 * Converts a class name to a pluralized snake_case table name.
 */
export function classnameToTablename(className: string): string {
  const snakeCase = className.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

  return pluralize(snakeCase);
}
