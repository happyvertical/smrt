# #4171 behavior contract
Base 9664c6d138 (0.57.13). Final scope: scanner path inheritance, registry live collection ancestry, generated explicit-host startup metadata, and HTTP CLI discovery (four production files). High risk: public authenticated discovery/authorization boundary. No schema ownership or policy changes.

|Behavior/invariant|Reachable trigger|Positive|Negative/failure|Actor/context|Executor/transaction|Runtime/dialect|Contract edge|Level/command|
|---|---|---|---|---|---|---|---|---|
|Explicit collection path retains item storage|scanner merge typed collection|explicit workitemresources, canonical work_items schema|unset namespace inherits workitems|build author|N/A metadata only, no writes|Node26, dialect independent|missing optional collection|core manifest test / core test|
|Only explicitly exposed custom actions discovered|GET _resources|API exposed CLI include static and instance methods, collection scope|CRUD/default/mirror/wildcard/malformed/excluded/API-hidden omitted|authenticated vs anonymous, tenant-a vs tenant-b policy|N/A discovery no mutation|Node26 HTTP|unknown/malformed include, no method|users resource-list test / users test|
|Actual collection constructor owns execution|generated route invocation through real registry|qualified item identity resolves registered facade; static method receives opaque options|anonymous401, facade grant403, correct item grant200, trusted tenant context ignores body claims|user permissions and active tenant|actual registered collection, isolated in-memory DB; action itself no mutation; rollback N/A|Node26 SQLite; no dialect-specific SQL changed|upstream method failure preserved; unknown payload retained; no enum contract|core generated runtime + actual registry constructor test / core test|
|Model and ordinary collection defaults unchanged|existing tests|model resource unchanged|no implicit collection CRUD or schema tables|existing callers|N/A no persistence change|existing supported suite|collision and unsupported method warnings retained|full existing users/core + root suites|

No production schema/SQL changes. SQLite only exercises constructor setup; no storage query or mutation occurs. Other SQL dialects are N/A for this metadata/HTTP boundary. Discovery tenant allow/deny is exercised by the existing caller-supplied command policy; row ownership remains domain action authority.

## Regression comparison

Against v0.57.13 production behavior, the explicit collection inheritance case
fails (`workitems` replaces `workitemresources`), and discovery fails (zero
resources instead of the explicitly included custom action resource). The
unset-name control and the existing model/default discovery tests remain green.
The generated-route probe already passes against base: this change restores
metadata/discovery reachability, rather than adding a new execution mechanism.
The probe obtains the real facade from `ObjectRegistry.getCollection`, uses its
actual constructor, then bundles and invokes the generated route through the
existing runtime fixture. The fixture's route-access shim records the qualified
lookup and delegates to the real registry with the isolated database; it does not prove a consumer's
application configuration or production database setup.

One initial runtime harness attempt lacked exports required by generated
registration. That setup failure is retained separately from the genuine
fail-before regressions and corrected before the passing execution probe.
Full command output is retained externally under
`/Users/will/.codex/planner-recovery-2026-10-19/shipping-collection-discovery/`.

## Final startup and ancestry coverage

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
|---|---|---|---|---|---|---|---|---|
| Undecorated collection parent remains schema-free | Registered real facade with missing parent metadata | Actual prototype identity recognizes collection; inherited method survives | Model named SmrtCollection or declaring _itemClass stays a model; unrelated shared table still rejected; metadata-only behavior unchanged | Trusted source constructors | Metadata only, no writes/transaction | Node, dialect independent | Missing optional parent registration/constructor | core issue-4171-collection-ancestry.test.ts; root test |
| Generated startup reaches discovery and real receiver | Fresh child process generates/imports startup with separate model/undecorated parent/facade files | No preregistration; named custom command discovered at explicit path; actual model-keyed collection constructor and inherited method used | Ordinary collection startup metadata unchanged, no CRUD; anonymous and wrong tenant discovery denied | Real public registry/users package; trusted session vs anonymous/tenant-b | Isolated SQLite collection; schema introspection proves only canonical schema and no runtime-created application table; action fixture itself does no persistence, rollback N/A | Node26 SQLite; SQL dialect variants N/A, no production SQL | Parent metadata closure, generated registration, discovery and route | users collection-action-startup.test.ts + fixtures/collection-action-startup.mjs; full users/root test |
| Existing action authority survives explicit route path | Execute bundled generated POST after real startup | Item grant + actor/active tenant + matching domain owner succeeds; opaque nested options preserved | Missing actor401, facade-path grant403, mismatched active tenant403, wrong domain owner403; typed domain409 retained | Actor × owner tenant × active tenant, no admin bypass | Real collection/database lookup; fixture domain action owns row policy; no mutation/retry/transaction contract added | Node26 HTTP | Upstream typed failure and unknown payload retained; no enum contract | same startup fixture |

External fail-before probes independently reproduced live constructor plus
schema ownership rejection and generated startup returning no facade metadata /
zero discovery resources. The initial two-file full root test was cancelled as
superseded when these integration gaps were confirmed; it is not a full green
result or review credit. Its logs are historical only. The final four-file
contract is validated afresh after source freeze.
