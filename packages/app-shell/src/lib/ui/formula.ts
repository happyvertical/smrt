import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { fieldLabel } from './fields.ts';
import type { FieldDef } from './types.ts';

/** Display only: the database alone evaluates formulas. Parentheses preserve meaning. */
export function formulaWords(
  node: GeneratedExpression,
  fields: Record<string, FieldDef> = {},
): string {
  const words = (child: GeneratedExpression) => formulaWords(child, fields);
  const nested = (child: GeneratedExpression) =>
    'op' in child ? `(${words(child)})` : words(child);
  if ('col' in node)
    return fields[node.col]
      ? fieldLabel(node.col, fields[node.col])
      : 'Removed field';
  if ('value' in node)
    return node.value === null
      ? 'nothing'
      : typeof node.value === 'boolean'
        ? node.value
          ? 'Yes'
          : 'No'
        : String(node.value);
  if ('left' in node) {
    const operators = {
      add: '+',
      sub: '−',
      mul: '×',
      div: '÷',
      mod: 'remainder after dividing by',
      eq: 'equals',
      ne: 'does not equal',
      lt: 'is less than',
      lte: 'is at most',
      gt: 'is greater than',
      gte: 'is at least',
    };
    return `${nested(node.left)} ${operators[node.op]} ${nested(node.right)}`;
  }
  if ('operands' in node)
    return node.op === 'coalesce'
      ? `First available of ${node.operands.map(words).join(', ')}`
      : node.operands.map(nested).join(node.op === 'and' ? ' and ' : ' or ');
  if (node.op === 'secondsBetween')
    return `Seconds from ${words(node.earlier)} to ${words(node.later)}`;
  if ('operand' in node) {
    const value = nested(node.operand);
    switch (node.op) {
      case 'not':
        return `Not ${value}`;
      case 'isNull':
        return `${value} is empty`;
      case 'isNotNull':
        return `${value} is not empty`;
      case 'asText':
        return `${value} as text`;
    }
  }
  return 'Unknown formula';
}
