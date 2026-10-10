/**
 * Positive identification of the NATIVE DuckDB adapter (#3737).
 *
 * The JSON adapter wraps the same `DuckDBConnection` class and the same SQL
 * dialect, but persists a table to `<table>.json` only from its own
 * insert/update/upsert/delete, so a raw write there is lost on the next
 * process. Only a root native handle can be told apart structurally: it
 * exposes `getTableSchema`, which the JSON adapter does not. A transaction
 * handle exposes neither marker (it carries the root's `client` and nothing
 * more), so it is recognized through its client once the root was noted.
 *
 * Roots are noted wherever core sees one before binding to a transaction:
 * `SmrtClass.initialize()`, `withDatabase()` (the handle being swapped out)
 * and `withEmbeddedWriteTransaction()`. A transaction handle whose root core
 * never saw stays unidentified, and its writers keep the adapter `upsert`
 * path; it is never treated as native by guesswork.
 */

const nativeClients = new WeakSet<object>();

interface AdapterHandle {
  client?: unknown;
  getTableSchema?: unknown;
  inferSchemaFromJSON?: unknown;
  getTableLoadErrors?: unknown;
}

function duckDbClientOf(db: unknown): object | undefined {
  const client = (db as AdapterHandle | null | undefined)?.client;
  if (client === null || typeof client !== 'object') return undefined;
  const name = (
    client as { constructor?: { name?: string } }
  ).constructor?.name?.toLowerCase();
  return name?.includes('duckdb') ? client : undefined;
}

/** Whether `db` carries a capability only the JSON adapter has. */
export function isJsonAdapterHandle(db: unknown): boolean {
  const handle = db as AdapterHandle | null | undefined;
  return (
    typeof handle?.inferSchemaFromJSON === 'function' ||
    typeof handle?.getTableLoadErrors === 'function'
  );
}

/**
 * Remember `db`'s client when `db` is positively a native DuckDB root: a
 * DuckDB client, no JSON-only capability, and the native structural marker or
 * an explicit `duckdb` engine hint. A `json` hint never registers.
 */
export function noteNativeDuckDbHandle(db: unknown, engineHint?: string): void {
  if (engineHint === 'json' || isJsonAdapterHandle(db)) return;
  const client = duckDbClientOf(db);
  if (!client) return;
  if (
    typeof (db as AdapterHandle).getTableSchema === 'function' ||
    engineHint === 'duckdb'
  ) {
    nativeClients.add(client);
  }
}

/** Whether `db` (a root or any of its transaction handles) is native DuckDB. */
export function isKnownNativeDuckDbHandle(
  db: unknown,
  engineHint?: string,
): boolean {
  if (engineHint === 'json' || isJsonAdapterHandle(db)) return false;
  noteNativeDuckDbHandle(db, engineHint);
  const client = duckDbClientOf(db);
  return client !== undefined && nativeClients.has(client);
}
