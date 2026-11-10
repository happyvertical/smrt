/**
 * Learner interest theme: a short free label and an optional stable key that a
 * host uses to flavour requested lessons and tutor examples. It is a skin for
 * stories and examples only, never an objective, and carries no private
 * details. The package ships no starter list; the host supplies its own keys.
 */
export const MAX_INTEREST_THEME_LABEL_CHARS = 60;
export const MAX_INTEREST_THEME_KEY_CHARS = 40;

/** Lowercase letters, digits and hyphens, starting with a letter or digit. */
const KEY = /^[a-z0-9][a-z0-9-]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
// Contact-detail shapes are refused so the slot cannot carry private details.
const CONTACT = /@|:\/\/|www\./i;

/** Learner-audience-safe projection of the stored theme. */
export type InterestTheme = Readonly<{
  /** Short display text, 1-60 characters. */
  label: string;
  /** Optional stable host key (`minecraft`); empty when the theme is free text. */
  key: string;
}>;

/** The shape a caller supplies; `null` clears the theme. */
export type InterestThemeInput = Readonly<{ label: string; key?: string }>;

/** Collapses internal whitespace; returns null when the input is not a valid theme. */
export function parseInterestTheme(raw: unknown): InterestTheme | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { label, key } = raw as { label?: unknown; key?: unknown };
  if (typeof label !== 'string' || CONTROL.test(label)) return null;
  const text = label.trim().replace(/\s+/g, ' ');
  if (
    !text ||
    text.length > MAX_INTEREST_THEME_LABEL_CHARS ||
    CONTACT.test(text)
  )
    return null;
  if (key === undefined || key === null || key === '')
    return { label: text, key: '' };
  if (
    typeof key !== 'string' ||
    key.length > MAX_INTEREST_THEME_KEY_CHARS ||
    !KEY.test(key)
  )
    return null;
  return { label: text, key };
}

/** Stored columns to the view; both empty means no theme. */
export function interestThemeFromColumns(
  label: unknown,
  key: unknown,
): InterestTheme | null {
  return typeof label === 'string' && label
    ? { label, key: typeof key === 'string' ? key : '' }
    : null;
}
