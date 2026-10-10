# Generated registration dependencies (#3761)

The generated server registration snapshot now matches normal production
provider discovery: assets, core, profiles, prompts and tenancy. Types and UI
remain package dependencies, but their only manifests are marked
`artifactPurpose: "test"`; they are not production SMRT runtime providers.
The existing production artifact boundary (#3220) excludes them. The Image
object payload is unchanged; only stale `smrtDependencies` metadata is refreshed.
Do not restore a stale generated snapshot after a normal build.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test level / validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production provider inventory | Images generation | Fresh discovery and generated snapshot list same five providers | Types/UI test-only artifacts excluded | Build process; no application actor | N/A: generated filesystem metadata, no application writes | Node26 / SQL N/A | Test versus production manifests | 18 owning discovery tests + 2 test-artifact-boundary tests |
| Stable object registration | Load generated snapshot | Image payload unchanged | No schema, field, method, identity or grant drift | Images server registry | N/A transaction: static registration | Node26 | Existing public registration contract | Parsed HEAD/current object payload equality |

Evidence: fresh `discoverSmrtPackages({baseDir: "packages/images", noCache: true})`
returns the same five providers as both `.smrt/manifest.json` and
`dist/manifest.json`. Parsed HEAD/current registration object payloads are equal.
All 20 focused tests pass; full outputs are retained in release evidence under
`search/images-discovery-diagnosis.log`, `search/images-artifact-boundary.log`
and `search/images-live-discovery.log`.

```sh
pnpm --filter @happyvertical/smrt-core exec vitest run src/manifest/__tests__/discover-smrt-packages.test.ts src/manifest/__tests__/discover-smrt-packages-coverage.test.ts src/manifest/__tests__/test-artifact-boundary.test.ts
```

This is a stale generated metadata refresh, with no owning generator behavior
change; base failure reproduction is N/A. The base comparison instead proves
that only the two test-only provider names differ. The coordinator owns normal
full source build/test and final review coverage.

The coordinator-selected 0.55.9 images tarball was compared with `dist` before
the later 0.55.10 base integration:
all 92 files are byte-identical, including source maps and knowledge metadata,
with no missing or extra files. The application profile already contains the
correct runtime artifacts; this tracked-source refresh needs no profile repack.
Detailed hashes/comparison are in `search/images-profile-compare.json`.

Integrating upstream `fef6fd069` required regenerating the conflicting registration
through the normal images build. The result exactly matches upstream's generated
file: `packageVersion` advances to 0.55.10, with the same five production providers
and unchanged Image object payload. The owning build and all 20 boundary tests
pass again. The application intentionally retains its earlier pinned producer
profile; this source base advance does not change that installed profile.
Merge evidence is in `search/images-base-merge-build-r2.log`,
`search/images-base-merge-boundary.log` and `search/images-base-merge-delta.json`.
