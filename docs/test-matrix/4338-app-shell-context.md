# #4338 — AppShell context without chrome

Risk: standard. Svelte context registration only; no auth, schema or persistence
contract change. Plan: register AppShell's existing canonical shell state before
rendering either chrome branch. Keep AdminShell's registration compatible. Render
real settings below chrome-free AppShell and prove the context object is exactly
the state created by AppShell, not an independent second store.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Settings context exists | AppShell chrome=false + ShellSettingsPage | Appearance/account/layout render | Base throws missing context | Any UI actor, no authority change | N/A context only | Browser jsdom/Svelte5; SQL N/A | N/A local API | Component: AppShell.chrome + ShellSettingsPage tests |
| One canonical state | Child calls useAdminShell | Same object as AppShell createShellState result | Reject duplicate store by identity and call count | Custom host chrome | N/A no transaction | Browser jsdom | Public context contract | Component regression |
| Chrome unchanged | Render default AppShell | AdminShell still rendered | chrome=false renders no phantom nav | All hosts | N/A presentation | Browser jsdom | N/A | Existing chrome/layout tests |
| Consumer integration | Actual Hearth layout/settings render | Settings renders within CookbookApp chrome=false | Base reproduces exact missing context error | Guardian/learner shell | Existing preferences unchanged | Node26 SSR/browser | Packed public entry | Consumer settings-composition.test.ts |

Commands/evidence are recorded after validation. Heavy root gates are coordinated
by the root session; this worker runs package build/test/typecheck and root style
and knowledge gates. No services or containers are required.

Worker evidence in `/Users/will/Work/tmp/hearth-touch-20261025/`:

- `framework-context-before.log`: new chrome-free state probe/settings regression
  fails with missing AdminShell context; 14 existing settings cases pass.
- `framework-context-after.log`: 3 files / 46 component cases pass, including
  strict state identity, existing chrome and layout behavior.
- `framework-svelte-build.log`, `framework-svelte-test.log`,
  `framework-svelte-typecheck.log`: package build, full unit suite (174 files /
  1927 cases), published-entry conformance (1 file / 4 cases), TypeScript and
  Svelte a11y check all exit 0. Svelte reports zero errors and 27 existing warnings.
- `framework-lint.log`, `framework-format-check.log`: root style gates exit 0.
- `framework-svelte-pack.log`: normal prepack build/verification and pack exit 0.
- Hearth's actual layout/Settings SSR fails against base public package
  (`settings-context-before.log`) and passes with corrected packed package
  (`settings-context-after.log`). Final consumer install/build/typecheck/test/lint
  pass, including 373 passing tests and 13 optional skips; no consumer context workaround.

The consumer fixture renders public ShellSettingsPage beneath the actual Hearth
layout specifically to exercise the provider contract. Product Settings is a
separate app-owned composition of trusted session account details, navigation
cards and public appearance controls; separate fixture cases verify its account,
role and signed-out views and absence of ineffective workspace controls.

Integrated validation completed by the root session after all package activity:
root build, full global tests, final global typecheck (157 tasks), audit policy,
style gates and strict knowledge all pass. Strict knowledge reports Errors: 0;
node-roots reports 49 OK with only existing allowlisted products. Browser QA
passes 17 checks; app independent review is CLEAN. Logs are retained in
`/Users/will/Work/tmp/hearth-touch-20261025/`.

Earlier strict knowledge checks and the first normal commit attempt encountered
regenerated snapshot/graph freshness during concurrent integrated validation.
The root session completed canonical regeneration after test activity and
verified the final strict gate green. No hook or gate was bypassed.
