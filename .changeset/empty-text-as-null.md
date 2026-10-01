---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-cli': minor
---

Converging a legacy `text` column to `timestamptz`, `jsonb` or an integer can now store empty or whitespace-only text as NULL (#3226). Opt in with `smrt db:migrate --empty-text-as-null` (preview with `smrt db:diff --empty-text-as-null`), or `emptyTextAsNull` on `SchemaComparer`/`migrateSmrtSchemas`. It applies only when the manifest and live columns are nullable and, for timestamps and JSON, only when empty text is the sole obstacle; any other value that does not cast still blocks. Without the opt-in, the blocking advisory for `timestamptz`/`jsonb` names the empty-text count, and the sample shows `(empty)` instead of `unavailable`; `text` -> integer is not probed at diff time, so a non-integer value fails only when the migration applies. `db:status` and `db:history` accept `--empty-text-as-null` so they report the same convergence as `db:migrate`. Changes that store empty text as NULL carry a `note` that `db:diff`/`db:migrate` print.
