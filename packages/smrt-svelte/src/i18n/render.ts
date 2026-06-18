/**
 * Client-side `{var}` interpolation (i18n, Sweep S13 #1418).
 *
 * A small, dependency-free copy of `@happyvertical/smrt-languages`'s
 * `renderTemplate`. The client deliberately does NOT import the languages
 * package: it is an optional peer with a heavy server dependency tree
 * (smrt-core, sql, ai, jobs…), and importing it from the always-bundled client
 * path (`Provider` → `/i18n`) would force every smrt-svelte consumer — including
 * downstream SvelteKit apps — to install that tree. The contract is tiny and
 * stable, so the client owns it; `__tests__/render-parity.spec.ts` pins it
 * against the canonical languages implementation so the two never drift.
 */

/** Variables substituted into `{var}` placeholders. */
export type LanguageVariables = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Render `{var}` placeholders against the supplied variables. Matches the
 * languages resolver's contract: `Date` → ISO string, array/object → JSON,
 * `null` / `undefined` → empty string; an empty/absent `variables` returns the
 * template unchanged (fast path).
 */
export function renderTemplate(
  template: string,
  variables?: LanguageVariables,
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (_match, rawKey: string) => {
    const value = variables[rawKey.trim()];

    if (value === undefined || value === null) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value) || isPlainObject(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return String(value);
  });
}
