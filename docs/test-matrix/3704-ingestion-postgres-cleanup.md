# #3704 PostgreSQL fixture cleanup

Risk: standard, test-fixture cleanup only. No production/schema/dependency change.
The supporting issue exceeds the ten-line incidental envelope because the strict
allowlist, three callers and executable regressions must move together.

| Behavior / trigger | Positive / failure case | Actor / executor | Runtime / edge | Evidence command |
| --- | --- | --- | --- | --- |
| Existing fixture names reach cleanup | exec_, ing_, ext_, sources_ plus exactly 32 lowercase hex; malformed prefix/suffix/injection rejected before SQL | Fixture owner / supplied query executor | Node 26, PostgreSQL SQL text | `pnpm exec vitest run src/postgres-cleanup.test.ts` |
| Ordinary DROP replaces FORCE teardown | Existing closed fixture drops; actual ordinary owner cannot FORCE a foreign-role backend but normal DROP retries until it closes | Ordinary CREATEDB owner and independent ordinary session / real PostgreSQL | PostgreSQL busy-session edge | Captured ordinary-role proof plus touched fixture suites |
| Only 55006 is retryable | Wrapped database-in-use retries; 42501, network/unknown SQLSTATE and unclassified errors propagate immediately | Fixture caller / same executor | Unit contract and real PostgreSQL | Unit suite and `src/postgres-cleanup.postgres.test.ts` |
| Persistent leak remains a failure | Held session survives failed cleanup at bounded deadline; release then repeated cleanup succeeds | Ordinary database owner / independent connection | Real PostgreSQL, no backend termination or privilege grants | PostgreSQL cleanup suite |
| All affected fixture callers use cleanup | Foundation, extraction and sources run complete PostgreSQL suites and teardown | Ordinary role / each fixture's owning admin connection | Real PostgreSQL | `vitest run --config vitest.postgres.config.ts src/foundation.postgres.test.ts src/extraction-service.postgres.test.ts src/sources.postgres.test.ts src/postgres-cleanup.postgres.test.ts` |

Regression: new allowed-prefix cases fail on the unchanged helper, then pass.
Actual failure/fix proof preserves PostgreSQL SQLSTATE 42501 from FORCE against a
foreign-role backend, and verifies the normal-drop helper waits without killing
that backend. Leaked connections remain terminal failures. No privilege grants or
test-timeout increases are permitted.

Validation: owning unit/affected PostgreSQL suites, types/build, root lint/format,
strict knowledge and agents checks, normal hooks. Provider/browser/domain runtime
suites are unchanged and N/A to this test-only cleanup patch. SQLite business
behavior is unchanged: the affected cleanup branches run only for PostgreSQL.
No transaction atomicity claim applies: PostgreSQL DROP DATABASE runs outside a
transaction on the supplied admin connection. No public API/export/schema changes.
