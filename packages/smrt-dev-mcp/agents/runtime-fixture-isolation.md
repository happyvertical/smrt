# Runtime fixture isolation (#3760)

Missing-dependency tests must not resolve packages installed in ancestor
`node_modules` directories. `project-runtime.test.ts` selects the first parent
(tmpdir then homedir) whose ancestry has none, matching the packed-consumer
fixture isolation rule. If both parents are contaminated, it asks for a clean
TMPDIR instead of silently borrowing packages. Production runtime resolution
continues to support ordinary hoisted workspace dependencies.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test level / validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hermetic missing-dependency fixture | Normal project-runtime suite | Missing config preserves runtime_dependency_unavailable | Ancestor node_modules cannot alter classification | Test process with polluted /tmp; no production actor | N/A: no application writes; test-owned filesystem only | Node26 / Node ESM lookup; SQL N/A | Host ancestor installations | Focused project-runtime.test.ts |
| Ancestor selection | Fixture allocation | Clean candidate selected | Candidate under node_modules ancestor rejected | Test-owned clean and polluted directory graph | N/A transaction: temporary dirs removed after each case | Node filesystem | Hoisted package lookup | Deterministic selector case in same file |

Regression evidence on the unchanged base: the exact three runtime setup cases
failed 1/3 with default `/tmp` ancestry. `/tmp/node_modules/@happyvertical/smrt-config`
was an existing unowned symlink to a separate 0.55.4 checkout; it was preserved.
An owned clean TMPDIR passed 3/3, confirming fixture contamination rather than a
runtime defect. That diagnosis does not replace the documented gate: the fixed
fixture must pass with the ordinary default environment and unchanged assertions.

Run `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/project-runtime.test.ts`.
Full outputs are retained under the release evidence `search/dev-mcp-*.log`.

Head evidence: the complete project-runtime file passes all 30 cases with the
ordinary default environment, including the unchanged missing-config assertion,
real config loading, hoisted workspace resolution and the new ancestor-selector
case. Biome passes the changed test file. No runtime code or packaged application
artifact changed; the coordinator reruns the documented combined source gate.
