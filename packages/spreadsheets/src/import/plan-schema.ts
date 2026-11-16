/** JSON shape of ImportPlan. validatePlan owns cross-field and SDK expression semantics. */
import {
  DEFAULT_PLAN_LIMITS,
  IMPORT_FIELD_TYPES,
  PLAN_KEY_PATTERN,
  PLAN_VALUE_LIMITS,
} from './plan.js';

const key = { type: 'string', pattern: PLAN_KEY_PATTERN.source };
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

/** Use with validatePlan: JSON Schema cannot express lookup graphs or expression typing. */
export const IMPORT_PLAN_SCHEMA: Record<string, unknown> = closed(
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
              range: { type: 'string' },
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
                  calculated: {},
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
                    items: label,
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
