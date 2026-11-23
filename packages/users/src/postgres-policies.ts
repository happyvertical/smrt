/**
 * Postgres policy generation, without the rest of the package. A host that
 * keeps run-time models in an app schema loads this subpath to generate and
 * apply their row-level-security policies.
 * @packageDocumentation
 */

export {
  applyScopedPostgresPermissionPolicies,
  type GeneratePostgresPermissionSqlResult,
  generatePostgresPermissionSql,
  type PostgresPolicyScope,
} from './services/PostgresPermissionPolicies.js';
