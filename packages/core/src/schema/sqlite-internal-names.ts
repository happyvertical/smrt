/**
 * SQLite reserves object names that begin with `sqlite_` (in any case) for
 * its own tables and automatic indexes. Catalog reads skip those, and only
 * those: in `LIKE`, `_` matches any one character, so `NOT LIKE 'sqlite_%'`
 * also skips user objects such as `sqliteX_unique`. The prefix is compared
 * literally, with the underscore escaped.
 *
 * Internal to core.
 */
export function sqliteUserObjectName(column = 'name'): string {
  return `${column} NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;
}
