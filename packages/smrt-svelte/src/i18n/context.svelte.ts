/**
 * i18n context + reactive store (Sweep S13 #1418).
 *
 * The `Provider` builds an `I18nStore` from a server snapshot and puts it on a
 * Svelte context; `useI18n()` / `$t` / `<Trans>` read it synchronously. Browser
 * safe — interpolation uses the client's own dependency-free `renderTemplate`
 * (see ./render.ts) so the heavy languages package is never bundled client-side.
 */

import { getContext, setContext } from 'svelte';
import { getRegisteredDefault } from './registry.js';
import { type LanguageVariables, renderTemplate } from './render.js';

/** A per-locale dictionary of message templates, as built on the server. */
export interface I18nSnapshot {
  /** The active locale (normalized BCP-47-ish tag). */
  locale: string;
  /** `key → template` for the active locale. Variables are applied client-side. */
  messages: Record<string, string>;
}

/**
 * Reactive holder for the active locale + message templates. Locale switching
 * (assigning `snapshot`) re-renders every `$t` / `<Trans>` reading this store.
 */
export class I18nStore {
  #locale = $state('en');
  #messages = $state<Record<string, string>>({});

  constructor(snapshot?: Partial<I18nSnapshot>) {
    if (snapshot?.locale) this.#locale = snapshot.locale;
    if (snapshot?.messages) this.#messages = snapshot.messages;
  }

  get locale(): string {
    return this.#locale;
  }

  /** Replace the active snapshot (e.g. on a locale switch). */
  set snapshot(snapshot: I18nSnapshot) {
    this.#locale = snapshot.locale;
    this.#messages = snapshot.messages;
  }

  /**
   * Resolve and interpolate a message. Resolution order: server-snapshot
   * template → registered English default → the key itself (a loud,
   * never-blank fallback). Interpolation uses the same `renderTemplate` the
   * server uses, so `{var}` placeholders render identically.
   */
  t = (key: string, vars?: LanguageVariables): string => {
    const template = this.#messages[key] ?? getRegisteredDefault(key) ?? key;
    return renderTemplate(template, vars);
  };
}

const I18N_KEY = Symbol('smrt-i18n');

/** Create a store from a snapshot (used by `Provider`). */
export function createI18nContext(snapshot?: Partial<I18nSnapshot>): I18nStore {
  return new I18nStore(snapshot);
}

/** Put an i18n store on context (used by `Provider`). */
export function setI18nContext(store: I18nStore): I18nStore {
  return setContext(I18N_KEY, store);
}

/** Read the i18n store, or `null` when there is no `Provider` above. */
export function tryGetI18nContext(): I18nStore | null {
  return getContext<I18nStore>(I18N_KEY) ?? null;
}

// A process-wide fallback store so `useI18n()` works outside a Provider
// (standalone primitives, tests) without throwing — it resolves through
// registered defaults. Created lazily to avoid running runes at module load.
let fallbackStore: I18nStore | null = null;

/** Read the i18n store, creating a default fallback if there is no Provider. */
export function getI18nContext(): I18nStore {
  const ctx = tryGetI18nContext();
  if (ctx) return ctx;
  if (!fallbackStore) fallbackStore = new I18nStore();
  return fallbackStore;
}
