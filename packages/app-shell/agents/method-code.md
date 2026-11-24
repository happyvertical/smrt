# Method-code entitlement (#5194, decision on #5597)

A hosted app runs app-authored method code (QuickJS, in the host process) only
for a tenant whose plan grants the standard feature `app.methods`
(`FEATURE_APP_METHODS`, smrt-features). The desktop and every non-cloud profile
always run it, with no lookup. Formulas are expression trees the database
evaluates; they never need the key.

Source: engine `src/engine/method-code.ts` (`MethodCodeGate`, `methodCodeTarget`,
`introducedCode`), the checks in `engine/host.ts` (`requireMethodCode`,
`onApp`, `applyChange`, `analyse` `addMethod`/`importTemplate`, `publishInputs`);
shell `src/lib/server/method-code.ts` (`installMethodCodeGate`,
`isMethodCodeEntitled`), `ShellContext.methodCode`, `hooks.server.ts` `init`,
`smrt.ts`. Tests: `engine/method-code.test.ts`, `lib/server/method-code.test.ts`.

- **Where it runs.** On the HOST, never in the worker. `HostOptions.methodCode`
  is `(tenantId) => boolean | Promise<boolean>`, called with the host's own
  tenant. Absent means allowed. A forked draft inherits it; the shell passes it
  to the live host and to a draft reopened after a restart, cloud holders only.
  Asked per call (no caching), so a plan change applies on the next call.
- **Run.** `onApp` refuses `runMethod`, a method tool (`callTool`) and a REST
  request whose path names a code-bearing method (`methodCodeTarget`) with
  `EngineError('refused')` and `details.code = 'method_code_not_enabled'`
  (routes keep that code, like `app_limit`). Any other op never reaches the
  sandbox; the test pins that over `WORKER_OPS`. A call that cannot run code is
  never charged a lookup.
- **Publish: refuse new code, keep old code inert.** `applyChange` (every
  structural command, undo, import) and `publishInputs` (preview and publish of
  a draft) refuse a definition that ADDS or CHANGES a method's code
  (`introducedCode`). `addMethod` and template import refuse before
  `checkSyntax`, so unentitled code never reaches a parser. Code already stored
  stays in the definition and is refused only at run. Chosen over refusing every
  definition that carries code because boot never validates against the key and
  an app that loses the key keeps booting, serving data and accepting unrelated
  changes (add a field, publish a draft); only its methods stop.
- **Fail closed.** A gate that throws (stores down, check not installed) refuses
  with `unavailable`; a non-`true` answer is a refusal.
- **Messages.** Owner-facing, no plan names or prices: the method, "not enabled
  for this workspace", records, reports and formulas keep working, method code
  runs in the desktop app.
- **Startup.** Cloud `init` builds the check (`installMethodCodeGate`) over the
  deployment database, or the server does not start. The desktop imports
  nothing.
- **Open.** Hosts that grant it still share one process; whether that needs a
  process boundary is decided before the key is first granted (#5597).
