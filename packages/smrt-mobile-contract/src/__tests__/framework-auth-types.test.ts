/**
 * Parity test: the TypeScript wire types (framework-types.ts) must match the
 * Kotlin framework contract (`MobileAuthContract.kt` literal in
 * emit-framework.ts) field-for-field. The TS side is compile-checked against
 * its own interfaces via `satisfies MobileWireShape<...>`, so this test
 * closes the loop: TS interfaces ↔ shape descriptors ↔ Kotlin data classes.
 */

import { describe, expect, it } from 'vitest';
import { frameworkKotlinFiles } from '../emit-framework.js';
import {
  MOBILE_AUTH_WIRE_SHAPES,
  type MobileWireFieldKind,
} from '../framework-types.js';

interface ParsedKotlinClass {
  name: string;
  fields: Record<string, MobileWireFieldKind>;
}

/**
 * Parses `data class Name(...)` declarations from the generated Kotlin
 * source. Fields are one-per-line in the framework contract, so a line-based
 * parse with paren-depth tracking is sufficient and keeps the test honest
 * about default values that contain parentheses (`emptyList()`,
 * `JsonObject(emptyMap())`).
 */
function parseKotlinDataClasses(source: string): ParsedKotlinClass[] {
  const classes: ParsedKotlinClass[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^data class (\w+)\($/u);
    if (!header) continue;

    const name = header[1];
    const fields: Record<string, MobileWireFieldKind> = {};
    let depth = 1;

    for (i += 1; i < lines.length && depth > 0; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
      }
      if (depth === 0) break;

      const field = line.match(
        /^\s*val (\w+): ([\w.<>]+\??)(\s*=\s*(.+?))?,\s*$/u,
      );
      if (!field) {
        throw new Error(
          `Unparseable field line in Kotlin data class ${name}: ${JSON.stringify(line)}`,
        );
      }
      const [, fieldName, type, defaultClause] = field;
      const nullable = type.endsWith('?');
      fields[fieldName] = nullable
        ? 'nullable'
        : defaultClause
          ? 'optional'
          : 'required';
    }

    classes.push({ name, fields });
  }

  return classes;
}

describe('mobile auth wire-type parity (TS ↔ Kotlin)', () => {
  const kotlinSource = frameworkKotlinFiles().get('MobileAuthContract.kt');

  it('finds the Kotlin auth contract in the framework file set', () => {
    expect(kotlinSource).toBeTruthy();
  });

  const parsed = parseKotlinDataClasses(kotlinSource ?? '');

  it('covers exactly the data classes the Kotlin contract declares', () => {
    expect(parsed.map((cls) => cls.name).sort()).toEqual(
      Object.keys(MOBILE_AUTH_WIRE_SHAPES).sort(),
    );
  });

  for (const cls of parsed) {
    it(`matches ${cls.name} field-for-field`, () => {
      expect(MOBILE_AUTH_WIRE_SHAPES[cls.name]).toEqual(cls.fields);
    });
  }

  it('treats every nullable Kotlin field as defaulted (safe partial deserialization)', () => {
    // The framework contract convention: `T?` fields always carry `= null`.
    // A nullable field WITHOUT a default would make omission a decode error
    // on the Kotlin side, which the 'nullable' kind (TS `?: T | null`)
    // would silently misrepresent.
    const kotlin = kotlinSource ?? '';
    for (const line of kotlin.split('\n')) {
      const nullableField = line.match(/^\s*val \w+: [\w.<>]+\?(.*)$/u);
      if (nullableField) {
        expect(nullableField[1]).toMatch(/^\s*=\s*null,\s*$/u);
      }
    }
  });
});
