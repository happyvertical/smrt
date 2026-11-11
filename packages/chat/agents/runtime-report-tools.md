# Runtime report tools (#3711)

Moved from `packages/chat/AGENTS.md` to keep the instruction chain under the 32 KB cap.

`createRuntimeReportTools()` (`runtime-report-tools.ts`) returns four
`PrincipalTool`s for the persona `extraTools` seam: `reports.runtime.sources`,
`reports.runtime.define` (`preview` / `apply`), `reports.runtime.list`, and
`reports.runtime.run`. The model supplies only a declarative
`RuntimeReportSpec` from `@happyvertical/smrt-reports`; sources are a
server-owned allow-list gated by `run.assertOperation(collection, 'read')`, and
field policy, `readPermission`, and tenancy are enforced by the compiler against
the live run on every compile and every stored-report run. `apply` needs the
`specHash` of the previewed spec plus an app-owned `confirmation` host that
resolves only after a human approved that exact spec; with no host apply returns an `awaiting_confirmation` proposal for the
same-origin browser confirm route and stores nothing and a model-supplied `confirmed` flag is ignored. Saving also needs
`create` on the `RuntimeReport` collection, and `list`/`run` need `read`; the
default `reportsCollection` is the `RuntimeReport` class itself, which resolves
to the catalog slug. A string `collection`/`reportsCollection` is used verbatim
as a catalog slug (never a class name); tests must run the tools under the real
`assertOperationPermission` guard so a wrong slug fails. A stored report is
written only by this confirmed `apply`: the model layer refuses every other
insert/spec change, and the generic manifest tools (`buildManifestToolCatalog`,
`invokeManifestTool`) never offer or run a `RuntimeReport` write. Stored-report
reads/saves run under the principal's tenant (`withPrincipalTenant`), refuse a
mismatching ambient tenant (checked before `confirmSave`), and filter by the principal tenant explicitly. Contract and authority model:
[`packages/reports/agents/runtime-reports.md`](../../reports/agents/runtime-reports.md).
