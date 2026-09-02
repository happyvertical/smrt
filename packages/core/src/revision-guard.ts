/**
 * Revision compare-and-swap predicate construction (#2620).
 *
 * `SmrtObject.save()` and {@link SmrtObject.claimRevision} guard every write to
 * a persisted row with a predicate on the revision the caller loaded. On
 * PostgreSQL that predicate cannot be a plain equality against
 * `Date.prototype.toISOString()`, because the JavaScript `Date` that carries the
 * revision is two lossy conversions away from the stored value:
 *
 * 1. **Precision.** `updated_at` is a microsecond column — `timestamptz(6)` on
 *    schemas this version materializes, `timestamp(6)` on older ones — so any
 *    row last written by raw SQL (`updated_at = CURRENT_TIMESTAMP` / `now()`)
 *    stores microseconds, for example `2026-09-02 08:11:28.939980`. A `Date`
 *    holds milliseconds, so the exact-equality predicate matched no row and
 *    every later `save()` on that row raised `RUNTIME_REVISION_CONFLICT`
 *    forever — a permanent failure, not a lost race.
 * 2. **Process timezone.** Schemas created before the `TIMESTAMPTZ` mapping
 *    still hold `updated_at` as `timestamp WITHOUT time zone`, and `pg`
 *    hydrates that type by reading the stored wall clock in the *process* zone.
 *    On a non-UTC host the resulting `Date` is offset from the instant the
 *    writer meant, so `toISOString()` produced a wall clock the row never held
 *    and every guarded save conflicted. The same columns are also written under
 *    three different conventions — `pg` serializes a `Date` in the process
 *    zone, `claimRevision()` writes a UTC ISO string, and raw
 *    `CURRENT_TIMESTAMP` writes in the *server* zone — so no single rendering
 *    can match every row.
 *
 * Both are fixed here without asking callers to compensate:
 *
 * - the column is truncated to milliseconds in SQL, the finest precision a
 *   `Date` can represent, so a microsecond tail can no longer hide the row; and
 * - the revision is offered in **both** wall-clock renderings — the process-zone
 *   one (the inverse of `pg`'s local hydration of `timestamp`) and the UTC one
 *   (what `timestamptz` hydration and SMRT's own ISO writes produce). Each is
 *   tagged `+00`, which a `timestamptz` comparison honours and a `timestamp`
 *   comparison discards, so the predicate never depends on the *session*
 *   TimeZone either. Accepting either candidate keeps the guard correct
 *   whatever convention the column and driver use, so a future UTC-hydration
 *   fix in `@happyvertical/sql` cannot silently break it. That driver-layer
 *   half is tracked as happyvertical/sdk#1223; this guard deliberately does not
 *   wait for it.
 *
 * Lost-race semantics are preserved. A concurrent writer advances `updated_at`
 * to roughly "now" (see `nextRevisionTimestamp`), which would have to land on
 * the loaded revision — or, on a non-UTC process only, on exactly that revision
 * shifted by the process's whole-hour-scale UTC offset — to the millisecond
 * before it could slip past. Any ordinary concurrent write differs by at least
 * one millisecond and still conflicts. On a UTC process the two renderings
 * coincide and the predicate is single-valued, so it is strictly no weaker than
 * the exact equality it replaces. Making it single-valued on a non-UTC process
 * too — by resolving the column's actual type, or by deleting the process-zone
 * rendering once happyvertical/sdk#1223 hydrates `timestamp` as UTC — is
 * tracked as #2623.
 *
 * The predicate is PostgreSQL-only. Embedded engines take the compare/upsert
 * fallback in `usesEmbeddedRevisionFallback`, and remote LibSQL stores ISO text
 * whose exact equality already round-trips losslessly.
 */

import { raw } from '@happyvertical/sql';

/** The SQL expression the PostgreSQL revision predicate compares against. */
export const POSTGRES_REVISION_GUARD_EXPRESSION =
  "date_trunc('milliseconds', updated_at)";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatWallClock(
  parts: [number, number, number, number, number, number, number],
): string {
  const [year, month, day, hours, minutes, seconds, milliseconds] = parts;
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)} ` +
    `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}+00`
  );
}

/**
 * Render a revision as every `timestamp without time zone` wall clock it could
 * legitimately correspond to, at millisecond precision.
 *
 * The process-zone rendering comes first because it is the inverse of `pg`'s
 * current hydration; the UTC rendering is what SMRT's own writes persist. On a
 * UTC process the two coincide and a single candidate is returned.
 *
 * @param revision - Revision loaded from the row, or supplied by the caller as
 *   `save({ expectedUpdatedAt })` / `claimRevision()`. Strings are parsed with
 *   `Date` semantics, so an ISO instant and a bare SQL wall clock both work.
 * @returns One or two `YYYY-MM-DD HH:MM:SS.mmm+00` strings
 * @throws {RangeError} If `revision` does not parse to a valid date
 */
export function postgresRevisionCandidates(revision: Date | string): string[] {
  const date = revision instanceof Date ? revision : new Date(revision);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(
      `Revision guard requires a valid timestamp, received: ${String(revision)}`,
    );
  }
  const local = formatWallClock([
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ]);
  const utc = formatWallClock([
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ]);
  return local === utc ? [local] : [local, utc];
}

/**
 * Build the PostgreSQL revision condition for a generic `db.update()` WHERE
 * clause.
 *
 * @param revision - The revision the writer loaded
 * @returns A single-entry condition object to spread into the update predicate
 */
export function postgresRevisionCondition(
  revision: Date | string,
): Record<string, string[]> {
  return {
    [raw(`${POSTGRES_REVISION_GUARD_EXPRESSION} in`)]:
      postgresRevisionCandidates(revision),
  };
}
