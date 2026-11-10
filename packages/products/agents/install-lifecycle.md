# Products install lifecycle (#4316)

`scripts/prepare.mjs` defers its opportunistic source build while declared
production workspace dependencies lack compiled `main`/`types` files or core's
public `./vite-plugin` import/types files. A directory containing only manifest
metadata is not a completed build. Deferral names the missing prerequisites;
`pnpm build` performs the normal dependency-ordered workspace build.

Missing, malformed or incorrectly linked installed dependency manifests are
errors. Once prerequisites exist, prepare invokes the real build and propagates
its exit status or signal. It never converts a failed build into success.

Packed manifests use compiled `main`/`types` artifacts without rebuilding source;
missing artifacts fail. Keep the helper in the published `files` allow-list.
The fixtures also verify pnpm's actual packed lifecycle metadata.

Run `node --test packages/products/scripts/prepare.test.mjs` from the repository
root, or the package's normal `pnpm test` (lifecycle checks followed by Vitest).

| Behavior | Trigger | Positive | Negative | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Defer only for unbuilt prerequisites | Cold or core-only install | Install names missing files and defers | Complete prerequisites run the build | Developer/package installer | Filesystem and child process; no SQL transaction | Node 26/pnpm 11; no DB | Real workspace install lifecycle | Integration | `node --test packages/products/scripts/prepare.test.mjs` |
| Metadata is not compiled readiness | Metadata-only dist or missing types/plugin output | Explicit deferral until required files exist | Dist path that is a regular file fails | Installer in partially built workspace | Filesystem; no SQL transaction | Node 26/pnpm 11; no DB | Declared package entrypoints | Integration | `node --test packages/products/scripts/prepare.test.mjs` |
| Invalid installs remain errors | Dependency absent, malformed or mislinked | Valid dependency manifests proceed | Invalid installed identity/JSON fails before deferral | Installer | Filesystem; no SQL transaction | Node 26/pnpm 11; no DB | Installed workspace links | Integration | `node --test packages/products/scripts/prepare.test.mjs` |
| Preserve real build failures | Prepare starts after readiness | Successful child emits output | Nonzero exit or signal fails install | Installer with complete prerequisites | npm child; no SQL transaction | Node 26/pnpm 11; no DB | Child lifecycle termination | Integration | `node --test packages/products/scripts/prepare.test.mjs` |
| Preserve compiled consumers | Pack/unpack or non-workspace install | Compiled artifacts are retained without rebuilding | Missing compiled artifact is actionable | Package publisher/consumer | Tarball and filesystem; no SQL transaction | Node 26/pnpm 11; no DB | Packed metadata and files allow-list | Packaging integration | `node --test packages/products/scripts/prepare.test.mjs` |
