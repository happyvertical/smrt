/**
 * Shared SQL utilities that work in both browser and Node.js environments
 */

/**
 * Map of valid SQL operators for use in WHERE clauses
 */
const VALID_OPERATORS = {
  '=': '=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
  '!=': '!=',
  like: 'LIKE',
  in: 'IN',
} as const;

/**
 * Builds a SQL WHERE clause with parameterized values and flexible operators
 *
 * @param where - Record of conditions with optional operators in keys
 * @param startIndex - Starting index for parameter numbering (default: 1)
 * @returns Object containing the SQL clause and array of values
 *
 * @example Basic Usage:
 * ```typescript
 * buildWhere({
 *   'status': 'active',           // equals operator is default
 *   'price >': 100,              // greater than
 *   'stock <=': 5,               // less than or equal
 *   'category in': ['A', 'B'],   // IN clause for arrays
 *   'name like': '%shirt%'       // LIKE for pattern matching
 * });
 * ```
 *
 * @example NULL Handling:
 * ```typescript
 * buildWhere({
 *   'deleted_at': null,          // becomes "deleted_at IS NULL"
 *   'updated_at !=': null,       // becomes "updated_at IS NOT NULL"
 *   'status': 'active'           // regular comparison
 * });
 * ```
 *
 * @example Common Patterns:
 * ```typescript
 * // Price range
 * buildWhere({
 *   'price >=': 10,
 *   'price <': 100
 * });
 *
 * // Date filtering
 * buildWhere({
 *   'created_at >': startDate,
 *   'created_at <=': endDate,
 *   'deleted_at': null
 * });
 *
 * // Search with LIKE
 * buildWhere({
 *   'title like': '%search%',
 *   'description like': '%search%',
 *   'status': 'published'
 * });
 *
 * // Multiple values with IN
 * buildWhere({
 *   'role in': ['admin', 'editor'],
 *   'active': true,
 *   'last_login !=': null
 * });
 * ```
 *
 * The function handles:
 * - Standard comparisons (=, >, >=, <, <=, !=)
 * - NULL checks (IS NULL, IS NOT NULL)
 * - IN clauses for arrays
 * - LIKE for pattern matching
 * - Multiple conditions combined with AND
 */
export const buildWhere = (where: Record<string, any>, startIndex = 1) => {
  let sql = '';
  const values: any[] = [];
  let currIndex = startIndex;

  if (where && Object.keys(where).length > 0) {
    sql = 'WHERE ';
    for (const [fullKey, value] of Object.entries(where)) {
      const [field, operator = '='] = fullKey.split(' ');
      const sqlOperator =
        VALID_OPERATORS[operator as keyof typeof VALID_OPERATORS] || '=';

      if (sql !== 'WHERE ') {
        sql += ' AND ';
      }

      if (value === null) {
        sql += `${field} IS ${sqlOperator === '=' ? 'NULL' : 'NOT NULL'}`;
      } else if (sqlOperator === 'IN' && Array.isArray(value)) {
        const placeholders = value.map(() => `$${currIndex++}`).join(', ');
        sql += `${field} IN (${placeholders})`;
        values.push(...value);
      } else {
        sql += `${field} ${sqlOperator} $${currIndex++}`;
        values.push(value);
      }
    }
  }

  return { sql, values };
};
