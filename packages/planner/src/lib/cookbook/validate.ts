import { parseOverviews } from '../overviews/validate.ts';
import { type ParseCookbookOptions, parseCookbookWith } from './parse.ts';
import type { CookbookResult } from './types.ts';

const fail = (error: string): CookbookResult => ({ ok: false, error });

/**
 * Check an unknown value (a parsed file or stored JSON) and return a
 * normalised cookbook, or one clear sentence saying why not. Strict on
 * purpose: nothing is silently dropped, so a bad file never half-applies.
 * Page customisations are checked against the planner's widget registry; a
 * host without it uses `parseCookbookWith` (`./parse.ts`).
 */
export function parseCookbook(
  input: unknown,
  options: Omit<ParseCookbookOptions, 'overviews'> = {},
): CookbookResult {
  return parseCookbookWith(input, { ...options, overviews: parseOverviews });
}

/** Parse JSON text, then `parseCookbook` it. */
export function parseCookbookText(
  text: string,
  options: { dropUnknownRecipes?: boolean } = {},
): CookbookResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('This file is not valid JSON.');
  }
  try {
    return parseCookbook(value, options);
  } catch {
    return fail('This file is not a valid cookbook.');
  }
}
