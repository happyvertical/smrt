/** Portable expression shapes shared by model guidance and the JSON Schema. */
export const IMPORT_EXPRESSION_FORMS = [
  {
    ops: [
      'add',
      'sub',
      'mul',
      'div',
      'mod',
      'eq',
      'ne',
      'lt',
      'lte',
      'gt',
      'gte',
    ],
    args: ['left', 'right'],
  },
  { ops: ['secondsBetween', 'daysBetween'], args: ['later', 'earlier'] },
  { ops: ['not', 'isNull', 'isNotNull', 'asText'], args: ['operand'] },
  {
    ops: [
      'abs',
      'floor',
      'ceil',
      'lower',
      'upper',
      'trim',
      'length',
      'year',
      'month',
      'day',
    ],
    args: ['value'],
  },
  { ops: ['round'], args: ['value', 'digits'] },
  { ops: ['substring'], args: ['value', 'start', 'length'] },
  { ops: ['addDays'], args: ['value', 'days'] },
  { ops: ['if'], args: ['condition', 'then', 'else'] },
] as const;
export const IMPORT_EXPRESSION_LISTS = [
  { ops: ['and', 'or', 'coalesce', 'concat'], minimum: 1 },
  { ops: ['least', 'greatest'], minimum: 2 },
] as const;

/** Guidance for any model proposing ImportPlan, not a substitute for validatePlan. */
export const IMPORT_PLAN_GUIDE = `ImportPlan version 1 is closed JSON: no extra properties.
Keys: lowercase snake_case, start with a letter, at most 63 characters; no Object prototype names. Labels preserve the workbook's wording (at most 200 characters).
Tables: key, label, source, fields; optional lookupKey (1–16 direct-column field keys), titleField (a field key). Source is {sheet,range,headerRow,skipRows?,distinct?}. Range is sheet-local A1, includes header and data; headerRow and all columns/skipRows are ABSOLUTE one-based sheet positions. For title rows 1–2, header row 4 and data through 46: range "A4:G46", headerRow 4; column D is 4, not relative to range. skipRows lists absolute data rows to omit. distinct:true extracts unique mapped records; otherwise retain every row.
Fields: {key,label,type,required?} plus EXACTLY ONE source: column:number, calculated:expression, or reference:{table,by,columns}. Types: text, number, integer, boolean, date, money, choice, reference. Use text for identifiers such as SO-1001 or 0012. Choice requires choices:[nonblank unique strings]; only choice accepts choices. Money requires money:{currency:"CAD",scale:2}; currency is three uppercase letters, scale a whole number 0–6; only money accepts money. Reference type requires reference; other types cannot use it. Reference by is the target table's lookupKey field keys in exactly the same order; columns are source sheet column numbers in matching order. Example: customers.lookupKey:["name"], name.column:1; orders.customer.reference:{table:"customers",by:["name"],columns:[2]}. Target lookup values must be nonblank and unique. Reference graphs must be acyclic.
Calculated fields optionally have cachedColumn (absolute source column containing the workbook's cached formula result), never column as well. Always set cachedColumn for a translated workbook formula. Operands can ONLY read sibling direct-column fields, never reference fields, other calculated fields, another table, sheet coordinates, ranges or aggregates.
Expression E is one of these CLOSED JSON objects (every shown property is required):
{col:"field_key"}; {value:literal};
${IMPORT_EXPRESSION_FORMS.map(({ ops, args }) => `{op:${ops.map((op) => `"${op}"`).join('|')},${args.map((arg) => `${arg}:E`).join(',')}}`).join('\n')}
${IMPORT_EXPRESSION_LISTS.map(({ ops, minimum }) => `{op:${ops.map((op) => `"${op}"`).join('|')},operands:[E,...]} (at least ${minimum})`).join('\n')}
{op:"case",branches:[{when:E,then:E},...],else:E} (at least one branch).
Literal is a finite JSON number, string, boolean, null, or {kind:"date",iso:"YYYY-MM-DD"}/{kind:"datetime",iso:"YYYY-MM-DDTHH:mm:ss[.SSS]Z"} (an explicit ±HH:mm offset is also accepted). Dates must be real calendar dates in years 0001–9999. Strings cannot contain NUL. Expressions have bounded depth/size; keep them small.
Arithmetic operands are numeric, comparisons return boolean, and/or/not require booleans, lower/upper/trim/length/substring/concat use text. asText accepts numeric/text/boolean inputs, not dates. Conditional branches/coalesce/least/greatest must have compatible result types. Date operations require date columns or typed date literals; secondsBetween/daysBetween return numbers, addDays returns a date. Date parts year/month/day return numbers. lower/upper are portable ASCII transformations. Null propagates with SQL semantics; eq/ne against null test nullness. Division is fractional, division by zero yields null; integer/money results must nevertheless be safe whole integers. round has digits:E (literal integer -12..12); substring has start:E (literal integer 1..2147483647), length:E (literal integer 0..2147483647); addDays has days:E (literal integer -365000..365000). Field result types must match the expression result.
Money operands and results are MINOR UNITS, not workbook decimals: CAD 12.50 at scale 2 loads as 1250. Multiplying by integer qty 2 yields 2500, proved against cached 25.00. Money times money needs scale correction. Round fractional outputs explicitly when a whole integer is required. Do not round source values to hide a discrepancy.
Worked example 1: Unit price (money, column 4, currency CAD scale 2), Qty (integer, column 5), Total (money, cachedColumn 6, same currency/scale): calculated={"op":"mul","left":{"col":"unit_price"},"right":{"col":"qty"}}.
Worked example 2: Price (money) with a 10% discount, whole minor-unit result: calculated={"op":"round","value":{"op":"mul","left":{"col":"price"},"right":{"value":0.9}},"digits":{"value":0}}.
No Excel/SQL expression strings, operator symbols (*,+), args arrays, arbitrary functions, cross-row/cross-sheet lookups, aggregate/range/volatile formulas or calculated-field chains. If a workbook formula cannot be represented, KEEP its source column as a plain field with column, not calculated/cachedColumn: the cached values are imported and the host lists formulas not translated for review. Never invent a translation. A wrong translation fails proof.
Reports are optional {key,label,spec}. spec is target-owned JSON, passed through unchanged; follow the host's report contract, or omit reports. For targets supporting RuntimeReportSpec, a minimal sum report spec is {"version":1,"title":"Sales","source":"orders","dimensions":[],"measures":[{"fn":"sum","field":"total","as":"revenue"}]}; source and field are plan keys, never SQL names. Group by adding dimensions:[{"field":"status","as":"status"}]. Only include fields that exist; omit uncertain reports. Do not invent a report query language.`;

/** Complete, validator-checked examples of the two worked calculations. */
export const IMPORT_PLAN_EXAMPLES = [
  {
    version: 1,
    reports: [
      {
        key: 'sales',
        label: 'Sales',
        spec: {
          version: 1,
          title: 'Sales',
          source: 'orders',
          dimensions: [],
          measures: [{ fn: 'sum', field: 'total', as: 'revenue' }],
        },
      },
    ],
    tables: [
      {
        key: 'orders',
        label: 'Orders',
        source: { sheet: 'Orders', range: 'A4:G46', headerRow: 4 },
        fields: [
          {
            key: 'unit_price',
            label: 'Unit price',
            type: 'money',
            column: 4,
            money: { currency: 'CAD', scale: 2 },
          },
          { key: 'qty', label: 'Qty', type: 'integer', column: 5 },
          {
            key: 'total',
            label: 'Total',
            type: 'money',
            cachedColumn: 6,
            money: { currency: 'CAD', scale: 2 },
            calculated: {
              op: 'mul',
              left: { col: 'unit_price' },
              right: { col: 'qty' },
            },
          },
        ],
      },
    ],
  },
  {
    version: 1,
    tables: [
      {
        key: 'items',
        label: 'Items',
        source: { sheet: 'Items', range: 'A1:B3', headerRow: 1 },
        fields: [
          {
            key: 'price',
            label: 'Price',
            type: 'money',
            column: 1,
            money: { currency: 'CAD', scale: 2 },
          },
          {
            key: 'discounted',
            label: 'Discounted',
            type: 'money',
            cachedColumn: 2,
            money: { currency: 'CAD', scale: 2 },
            calculated: {
              op: 'round',
              value: {
                op: 'mul',
                left: { col: 'price' },
                right: { value: 0.9 },
              },
              digits: { value: 0 },
            },
          },
        ],
      },
    ],
  },
];

/** Select a bounded relevant rule for repair rather than repeating the whole prompt. */
export function importPlanRule(path: string): string {
  if (/calculated/.test(path))
    return 'Use the closed expression objects above, with sibling direct-column field keys in {col}. mul uses left/right, not args or symbols. If unrepresentable, map the cached source column as a plain field.';
  if (/reference|lookupKey/.test(path))
    return 'reference:{table,by,columns}; by exactly matches target lookupKey in order; columns are absolute source column numbers.';
  if (/source/.test(path))
    return 'source:{sheet,range,headerRow}; range includes the header and data, headerRow is the absolute header row after any title block.';
  if (/money|choices/.test(path))
    return 'Only money has money:{currency,scale}; only choice has nonempty unique choices. See field rules above.';
  return 'Use closed ImportPlan version 1 JSON and exactly one source per field; see the grammar above.';
}
