/**
 * The table a run-time list gets when it states none (#5005): its snake-cased
 * plural. Its own module so migrate can read stored lists without loading the
 * run-time model machinery.
 */
import { toSnakeCase } from './utils/naming.js';

export function runtimeListTableName(name: string): string {
  const s = toSnakeCase(name).replace(/^_/, '');
  if (s.endsWith('s')) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}
