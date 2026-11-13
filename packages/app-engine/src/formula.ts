import type { GeneratedExpression } from '@happyvertical/smrt-core';

/** Display only: the database alone evaluates formulas. Parentheses preserve meaning. */
export function formulaWords(
  node: GeneratedExpression,
  labels: Record<string, string> = {},
): string {
  const words = (child: GeneratedExpression) => formulaWords(child, labels);
  const nested = (child: GeneratedExpression) =>
    'op' in child ? `(${words(child)})` : words(child);
  if ('col' in node) return labels[node.col] ?? 'Removed field';
  if (!('op' in node) && 'value' in node)
    return node.value === null
      ? 'nothing'
      : typeof node.value === 'boolean'
        ? node.value
          ? 'Yes'
          : 'No'
        : typeof node.value === 'object' && !(node.value instanceof Date)
          ? node.value.iso
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
  if ('operands' in node) {
    if (node.op === 'least' || node.op === 'greatest')
      return `${node.op === 'least' ? 'Least' : 'Greatest'} of ${node.operands.map(words).join(', ')}`;
    if (node.op === 'concat')
      return `Join ${node.operands.map(nested).join(', ')}`;
    return node.op === 'coalesce'
      ? `First available of ${node.operands.map(words).join(', ')}`
      : node.operands.map(nested).join(node.op === 'and' ? ' and ' : ' or ');
  }
  if (node.op === 'if')
    return `if ${words(node.condition)} then ${words(node.then)}, otherwise ${words(node.else)}`;
  if (node.op === 'case')
    return `${node.branches.map((b, i) => `${i ? 'otherwise if' : 'if'} ${words(b.when)} then ${words(b.then)}`).join(', ')}, otherwise ${words(node.else)}`;
  if (node.op === 'secondsBetween' || node.op === 'daysBetween')
    return `${node.op === 'secondsBetween' ? 'Seconds' : 'Days'} from ${words(node.earlier)} to ${words(node.later)}`;
  if ('value' in node) {
    const value = nested(node.value);
    switch (node.op) {
      case 'round':
        return `${value} rounded to ${words(node.digits)} places`;
      case 'abs':
        return `Absolute value of ${value}`;
      case 'floor':
        return `${value} rounded down`;
      case 'ceil':
        return `${value} rounded up`;
      case 'lower':
        return `${value} in lowercase`;
      case 'upper':
        return `${value} in uppercase`;
      case 'trim':
        return `${value} without surrounding spaces`;
      case 'length':
        return `Length of ${value}`;
      case 'substring':
        return `${value} from character ${words(node.start)} for ${words(node.length)} characters`;
      case 'year':
        return `Year of ${value}`;
      case 'month':
        return `Month of ${value}`;
      case 'day':
        return `Day of ${value}`;
      case 'addDays':
        return `${value} plus ${words(node.days)} days`;
    }
  }
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
