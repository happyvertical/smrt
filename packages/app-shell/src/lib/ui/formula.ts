import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { formulaWords as describeFormula } from '../../engine/formula.ts';
import { fieldLabel } from './fields.ts';
import type { FieldDef } from './types.ts';

/** Shell labels over the shared display-only expression renderer. */
export function formulaWords(
  node: GeneratedExpression,
  fields: Record<string, FieldDef> = {},
): string {
  return describeFormula(
    node,
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        fieldLabel(name, field),
      ]),
    ),
  );
}
