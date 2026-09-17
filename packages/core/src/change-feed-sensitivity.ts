/**
 * Credential-bearing tables the change feed must never disclose (issue #2937).
 *
 * The feed records `{table, rowId, operation, tenantId}` for every observable
 * table, and the generated `/_changes` and `/_events` routes gate on nothing
 * but the presence of an authenticated principal — there is no per-table
 * permission check. That is fine for domain data, which is what the routes are
 * for, and a disclosure for any table whose **row id is itself a credential**.
 *
 * `@happyvertical/smrt-users`' `Session` is exactly that: `createSession()`
 * returns the row id, that value is the `sid` cookie and the `accessToken`
 * `TerminalAuthService` hands a device, and `loadSessionContext()` re-saves the
 * row on every authenticated request — so every live session id was being
 * rewritten into the feed continuously, where the lowest-privileged
 * authenticated caller could read it and replay it.
 *
 * ## The rule
 *
 * A table is *sensitive* when it is named by {@link CHANGE_FEED_CREDENTIAL_TABLES}
 * or when some registered class declared `@smrt({ sensitive: true })` for it.
 * Sensitive tables are not observable: they are refused on the write path, on
 * the live-signal path, and — because an earlier build already wrote their ids
 * into existing databases — on the **read** path, so upgrading is sufficient
 * and no operator has to purge anything by hand.
 *
 * ## Why both a declared marker and a baseline list
 *
 * The declared marker is the contract a package uses to make its own claim, and
 * it travels with the class through the scanner, the manifest and the registry.
 * It is not sufficient on its own, because it only takes effect in a process
 * where the owning package actually registered: a worker that loaded only core,
 * a replica still running yesterday's `smrt-users`, or a read-only handle
 * serving `/_changes` for a database some other process writes. The baseline
 * list is what makes the rule hold in those processes too — it is a property of
 * the *name*, which is all the read path has.
 *
 * The set is therefore **monotonic**: names are added and never removed, and
 * nothing here can be turned off by configuration. A consumer whose own domain
 * table is named `sessions` or `api_keys` loses change-feed coverage for it;
 * that is the deliberate direction to fail in, and the fix is to name the table
 * something else (`@smrt({ tableName })`), not to weaken the rule.
 *
 * This module is a leaf on purpose — it imports nothing — so both
 * `change-feed.ts` and `change-signals.ts` can consult it, and the registry can
 * populate it at registration time, without an import cycle.
 *
 * ## Why the set lives on `globalThis`
 *
 * For the same reason `ObjectRegistry` does (see `packages/core/AGENTS.md`):
 * this is a process-wide append-only registry written by one module (class
 * registration) and read by others (the feed writer, the feed reader, the
 * signal bus). A dev server's HMR reload, or a build that resolves two copies
 * of `@happyvertical/smrt-core` (hoisting mismatch, dual ESM/CJS entry,
 * bundler duplication), gives this file two module instances — and a
 * module-scope `Set` would then take a class's declaration in one instance
 * while the guards read the other's. The baseline names survive that, because
 * every instance re-seeds them from the same static array; a
 * **consumer-declared** table would not, and it would fail open silently, with
 * nothing logged. One shared `globalThis` slot removes the divergence.
 */

declare global {
  // eslint-disable-next-line no-var
  var __smrtChangeFeedSensitiveTables: Set<string> | undefined;
}

/**
 * Framework tables whose row id or stored payload is secret, by name.
 *
 * Audited for #2937 across `@happyvertical/smrt-users` and
 * `@happyvertical/smrt-profiles`:
 *
 * - `sessions` — the row **id is the bearer credential** (`sid` cookie value,
 *   terminal-auth `accessToken`).
 * - `users_cli_auth_requests` — device-code state: a plaintext `userCode` an
 *   approver can exchange, a `deviceCodeHash`, and the `sessionId` minted on
 *   approval.
 * - `users_magic_link_tokens` / `magic_link_tokens` — the replay-protection
 *   nonce and the login-token hash a `verify()` looks up by.
 * - `api_keys` — the API-key store (`keyHash`, `keyPrefix`, scopes).
 * - `nostr_identities` — custodial private-key material (AES-256-GCM
 *   ciphertext, IV and auth tag).
 *
 * The feed never carries column values, so for the hash-bearing tables what
 * this withholds is the row id and the write timing — an enumeration handle
 * onto a credential row, and a side channel that says when a credential was
 * issued, used or rotated. Neither belongs on a route every authenticated
 * principal can call.
 */
export const CHANGE_FEED_CREDENTIAL_TABLES: readonly string[] = [
  'sessions',
  'users_cli_auth_requests',
  'users_magic_link_tokens',
  'magic_link_tokens',
  'api_keys',
  'nostr_identities',
];

/**
 * The process-wide sensitive-table set, shared across every module instance.
 *
 * Seeded with the baseline on first access. A second module instance reaching
 * the already-created set re-adds the baseline names, which is a no-op for a
 * `Set` and keeps the invariant that the baseline is always present even if a
 * future edit changes the array.
 */
function sensitiveTableSet(): Set<string> {
  let set = globalThis.__smrtChangeFeedSensitiveTables;
  if (!set) {
    set = new Set<string>();
    globalThis.__smrtChangeFeedSensitiveTables = set;
  }
  for (const table of CHANGE_FEED_CREDENTIAL_TABLES) set.add(table);
  return set;
}

/**
 * Mark `tableName` credential-bearing for the rest of the process.
 *
 * Called from class registration for every class declaring
 * `@smrt({ sensitive: true })`. Idempotent, and deliberately one-way: a later
 * registration of the same table under a different config cannot un-mark it,
 * because a re-registration racing a read must not open the table back up.
 */
export function declareChangeFeedSensitiveTable(tableName: string): void {
  const name = tableName?.trim();
  if (!name) return;
  sensitiveTableSet().add(name);
}

/** Whether `tableName` is credential-bearing and must never reach the feed. */
export function isChangeFeedSensitiveTable(tableName: string): boolean {
  return Boolean(tableName) && sensitiveTableSet().has(tableName);
}

/**
 * Every sensitive table name, sorted.
 *
 * Used by the read path to build its exclusion predicate, and by diagnostics
 * that need to explain why a table reports no changes.
 */
export function getChangeFeedSensitiveTables(): string[] {
  return [...sensitiveTableSet()].sort();
}

/**
 * Resolves whether the class that produced an instance declared itself
 * sensitive. Supplied by the registry; see
 * {@link setChangeFeedSensitiveClassResolver}.
 */
export type ChangeFeedSensitiveClassResolver = (ctor: unknown) => boolean;

let sensitiveClassResolver: ChangeFeedSensitiveClassResolver | undefined;

/**
 * Register the registry's class-level `sensitive` lookup (dependency
 * inversion, exactly like the DispatchBus tenant resolver).
 *
 * ## Why the write path needs this and not just the name set
 *
 * Declaring by name at registration time assumes the name a class *declares*
 * is the name its rows are *recorded* under. Registration derives that name
 * from config and manifest, while the writer uses `instance.tableName`, which
 * resolves through the STI base's schema and then the class's own. Those
 * derivations are separate code, and where they disagree the declaration lands
 * on a name nothing writes under while the real table keeps appending — a
 * silent fail-open for exactly the consumer-declared tables the marker exists
 * to protect.
 *
 * Measured, for the record: STI is **not** such a case today. `@smrt()`
 * resolves an STI child to its base's table at registration, so a child
 * declaring `sensitive: true` already declares `<base>` — verified against a
 * real STI pair. The manifest-stub and manifest-merge paths derive the name
 * differently again (`decoratorConfig` versus `objectDef.schema.tableName`),
 * and registration now declares every candidate name to cover them.
 *
 * That list of candidates is still a list of guesses about someone else's
 * derivation. This resolver is the authoritative check: the write path holds
 * the instance, so it knows both the class and the exact `tableName` about to
 * be recorded, with no derivation to keep in sync. It declares that name on the
 * way past, which closes the read path and the signal bus for the same table.
 *
 * Kept in this leaf module so `change-feed.ts` never imports the registry —
 * `class.ts` already imports `change-feed.ts`, so the reverse edge would be a
 * cycle.
 */
export function setChangeFeedSensitiveClassResolver(
  resolver: ChangeFeedSensitiveClassResolver | undefined,
): void {
  sensitiveClassResolver = resolver;
}

/**
 * Whether `tableName`, about to be recorded for an instance of `constructor`,
 * is credential-bearing — by name, or because the class declared it.
 *
 * A class-declared hit also adds `tableName` to the set, so the read path and
 * the signal bus refuse the same table from then on.
 */
export function isChangeFeedSensitiveWrite(
  tableName: string,
  ctor: unknown,
): boolean {
  if (isChangeFeedSensitiveTable(tableName)) return true;
  if (!ctor || !sensitiveClassResolver) return false;
  let declared = false;
  try {
    declared = sensitiveClassResolver(ctor) === true;
  } catch {
    // A resolver failure must never fail the user's write; the name set still
    // covers every framework credential table.
    return false;
  }
  if (!declared) return false;
  declareChangeFeedSensitiveTable(tableName);
  return true;
}
