/** JSON shape of ImportPlan. validatePlan owns cross-field and SDK expression semantics. */
import {
  DEFAULT_PLAN_LIMITS,
  IMPORT_FIELD_TYPES,
  PLAN_KEY_PATTERN,
  PLAN_VALUE_LIMITS,
} from './plan.js';

import {
  IMPORT_EXPRESSION_FORMS,
  IMPORT_EXPRESSION_LISTS,
} from './plan-grammar.js';

const key = {
  type: 'string',
  pattern: PLAN_KEY_PATTERN.source,
  not: { enum: [...Object.getOwnPropertyNames(Object.prototype), 'prototype'] },
};
const label = {
  type: 'string',
  minLength: 1,
  maxLength: PLAN_VALUE_LIMITS.maxLabel,
};
const row = { type: 'integer', minimum: 1, maximum: PLAN_VALUE_LIMITS.maxRow };
const column = {
  type: 'integer',
  minimum: 1,
  maximum: PLAN_VALUE_LIMITS.maxColumn,
};
const keys = {
  type: 'array',
  items: key,
  minItems: 1,
  maxItems: 16,
  uniqueItems: true,
};
const closed = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

const operand = { $ref: '#/$defs/expression' };
const expression = {
  oneOf: [
    closed({ col: key }, ['col']),
    closed(
      {
        value: {
          anyOf: [
            { type: ['number', 'boolean', 'null'] },
            { type: 'string', pattern: '^[^\\u0000]*$' },
            closed(
              {
                kind: { const: 'date' },
                iso: {
                  type: 'string',
                  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
                },
              },
              ['kind', 'iso'],
            ),
            closed(
              {
                kind: { const: 'datetime' },
                iso: {
                  type: 'string',
                  pattern:
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$',
                },
              },
              ['kind', 'iso'],
            ),
          ],
        },
      },
      ['value'],
    ),
    ...IMPORT_EXPRESSION_FORMS.map(({ ops, args }) =>
      closed(
        {
          op: { enum: [...ops] },
          ...Object.fromEntries(args.map((arg) => [arg, operand])),
        },
        ['op', ...args],
      ),
    ),
    ...IMPORT_EXPRESSION_LISTS.map(({ ops, minimum }) =>
      closed(
        {
          op: { enum: [...ops] },
          operands: { type: 'array', items: operand, minItems: minimum },
        },
        ['op', 'operands'],
      ),
    ),
    closed(
      {
        op: { const: 'case' },
        branches: {
          type: 'array',
          minItems: 1,
          // biome-ignore lint/suspicious/noThenProperty: the expression grammar names this branch then.
          items: closed({ when: operand, then: operand }, ['when', 'then']),
        },
        else: operand,
      },
      ['op', 'branches', 'else'],
    ),
  ],
};

/** Use with validatePlan: JSON Schema cannot express lookup graphs or expression typing. */
const planShape = closed(
  {
    version: { const: 1 },
    tables: {
      type: 'array',
      minItems: 1,
      maxItems: DEFAULT_PLAN_LIMITS.maxTables,
      items: closed(
        {
          key,
          label,
          source: closed(
            {
              sheet: { type: 'string', minLength: 1, maxLength: 255 },
              range: {
                type: 'string',
                pattern:
                  '^\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]*(?::\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]*)?$',
              },
              headerRow: row,
              skipRows: {
                type: 'array',
                items: row,
                uniqueItems: true,
                maxItems: DEFAULT_PLAN_LIMITS.maxSkipRows,
              },
              distinct: { type: 'boolean' },
            },
            ['sheet', 'range', 'headerRow'],
          ),
          fields: {
            type: 'array',
            minItems: 1,
            maxItems: DEFAULT_PLAN_LIMITS.maxFieldsPerTable,
            items: {
              ...closed(
                {
                  key,
                  label,
                  type: { enum: [...IMPORT_FIELD_TYPES] },
                  required: { type: 'boolean' },
                  column,
                  cachedColumn: column,
                  calculated: operand,
                  reference: closed(
                    {
                      table: key,
                      by: keys,
                      columns: {
                        type: 'array',
                        items: column,
                        minItems: 1,
                        maxItems: 16,
                      },
                    },
                    ['table', 'by', 'columns'],
                  ),
                  choices: {
                    type: 'array',
                    items: { ...label, pattern: '^\\S(?:[\\s\\S]*\\S)?$' },
                    minItems: 1,
                    maxItems: DEFAULT_PLAN_LIMITS.maxChoices,
                    uniqueItems: true,
                  },
                  money: closed(
                    {
                      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
                      scale: { type: 'integer', minimum: 0, maximum: 6 },
                    },
                    ['currency', 'scale'],
                  ),
                },
                ['key', 'label', 'type'],
              ),
              allOf: [
                {
                  if: { required: ['cachedColumn'] },
                  // biome-ignore lint/suspicious/noThenProperty: then is a JSON Schema conditional keyword, not a promise.
                  then: { required: ['calculated'] },
                },
                ...(['money', 'choices', 'reference'] as const).map(
                  (member) => ({
                    if: {
                      properties: {
                        type: {
                          const: member === 'choices' ? 'choice' : member,
                        },
                      },
                    },
                    // biome-ignore lint/suspicious/noThenProperty: then is a JSON Schema conditional keyword, not a promise.
                    then: { required: [member] },
                    else: { not: { required: [member] } },
                  }),
                ),
              ],
              oneOf: [
                { required: ['column'] },
                { required: ['calculated'] },
                { required: ['reference'] },
              ],
            },
          },
          lookupKey: keys,
          titleField: key,
        },
        ['key', 'label', 'source', 'fields'],
      ),
    },
    reports: {
      type: 'array',
      maxItems: DEFAULT_PLAN_LIMITS.maxReports,
      items: closed({ key, label, spec: {} }, ['key', 'label', 'spec']),
    },
  },
  ['version', 'tables'],
);

export const IMPORT_PLAN_SCHEMA: Record<string, unknown> = {
  ...planShape,
  $defs: { expression },
};
