# Process fixture isolation (#3762)

The CLI process fixture must have no ancestor `node_modules` directory. Node's
normal hoisted dependency lookup otherwise lets the missing-Vite case find an
unrelated installed Vite after removing the fixture's local dependency. The
fixture uses the existing packed-consumer and dev-mcp admission pattern: prefer
the temporary directory, fall back to the home directory, and require a clean
TMPDIR when neither parent is isolated. Runtime lookup and assertions stay intact.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test level / validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Missing Vite is truly absent | Remove fixture node_modules | Launcher reports missing Vite with status 1 | Unrelated ancestor Vite cannot satisfy the fixture | Real CLI child process | N/A: disposable filesystem fixture | Node26; SQL N/A | Normal Node dependency lookup | Existing CLI process test |
| Fixture retains process behavior | Dev/build/vite commands | Arguments, environment, stderr and signal contracts hold | Unsafe/missing executable remains rejected | Fixture application | N/A: isolated child processes | Node26; SQL N/A | Fake local Vite and built CLI entry | All eight process tests |

Baseline ordinary execution reproduced seven passes and one failure: the absent
Vite case found the unowned `/tmp/node_modules/vite`, returning status 0 instead
of 1. An owned TMPDIR with clean ancestors passes all eight tests before the fix,
confirming fixture contamination. The corrected fixture passes the same eight
tests under the ordinary environment. No assertion, runtime dependency lookup,
unowned installation or packaged application artifact is changed.

```sh
pnpm --filter @happyvertical/smrt-cli exec vitest run src/app/__tests__/cli-process.test.ts
```

Full baseline, isolated diagnostic and corrected outputs are retained in release
evidence under `search/cli-fixture-base.log`,
`search/cli-fixture-clean-ancestor.log` and `search/cli-fixture-fixed-r2.log`.
The release coordinator owns combined source acceptance.
