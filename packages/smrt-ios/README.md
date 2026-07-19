# @happyvertical/smrt-ios

The SwiftUI half of the s-m-r-t mobile foundation (ADR 0001, epic #1745, Phase 6
issue #1743): `MobileTheme` design tokens, a tab shell scaffold bound to
smrt-mobile's shared `MobileShellState`, a SwiftUI observation bridge for
shared KMP presenters, and native platform adapters -- all **consuming the
exported `SmrtMobile` KMP framework** from
`packages/smrt-mobile`.

## Consuming (local filesystem, per the Phase 0 decision)

Distribution is deferred; the framework is consumed locally through XcodeGen.
`scripts/validate-ios.mjs --native` builds `SmrtMobile.framework` from
`packages/smrt-mobile` and stages it into `Frameworks/`, and `project.yml`
references it via `FRAMEWORK_SEARCH_PATHS`. Remote SPM would need an XCFramework
release (git-source SPM cannot target a monorepo subdirectory) — a distribution
follow-up.

The reusable foundation is `Sources/SmrtIos` (Swift module `SmrtIos`); apps
`import SmrtMobile` (shared logic) and `import SmrtIos` (theme/shell/adapters).
Wrap a presenter's exported `MobileStateHolder` in
`MobileObservableState(holder:)`, retain it as a SwiftUI `@StateObject`, and
render its published `value`.

Use `FoundationEvidenceByteSource` when converting a queued
`EvidenceMultipartUpload` at flush time. It resolves app-private files and
bulk-copies `Data` into Kotlin memory through `SmrtMobileIos`, avoiding an
element-by-element Swift bridge.

## Development

```bash
pnpm build                 # structural, SDK-free (no Xcode/Gradle needed)
pnpm validate:ios:native   # real build: Gradle framework → XcodeGen → xcodebuild + tests
```

`validate:ios:native` requires macOS with Xcode + XcodeGen, and `JAVA_HOME`
(JDK 21) + `ANDROID_HOME` for the smrt-mobile Gradle framework build. The sample
app (`Sample/SmrtIosSample`) is the on-device/simulator acceptance surface — it
drives the durable pack store, the write-queue, the barcode scanner, and the
device/LLM adapters against real shared logic (no `.sample` stubs).

Design record and decisions: see `AGENTS.md` here, ADR 0001 (+ extraction plan)
in `docs/content/adr/`, and the locked Phase 6 design record on issue #1743.
