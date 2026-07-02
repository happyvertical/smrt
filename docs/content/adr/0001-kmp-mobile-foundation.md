# ADR 0001: A Reusable KMP Mobile Foundation for SMRT

- **Status**: Accepted — Phase 0 decisions locked with the framework owner
  2026-07-01; see the
  [decision record](./0001-kmp-mobile-foundation-extraction-plan.md#phase-0-decision-record-locked-2026-07-01)
- **Date**: 2026-07-01
- **Deciders**: Will (framework owner)
- **Related**: [Extraction Plan](./0001-kmp-mobile-foundation-extraction-plan.md), [Products as Template](../architecture/products-as-template.md), [RFC-001 Multi-Tenancy](../rfcs/RFC-001-multi-tenancy.md)
- **Supersedes / Superseded by**: —

> This is the first **ADR** in the SMRT docs. It sits alongside the heavier
> `rfcs/` specs (which design a whole package surface) and the `architecture/`
> explainers (which document a shipped design). ADRs are deliberately lighter:
> one decision, the forces behind it,
> the alternatives rejected, and the consequences. See
> [Alternatives](#alternatives-considered) for why an ADR — not a full RFC — is
> the right weight for this decision.

## Context

SMRT ships **no mobile packages today**. `packages/` (48 packages at time of
writing) is entirely TypeScript/pnpm; there is no Kotlin, Swift, or KMP artifact
anywhere in the framework. Yet two HappyVertical apps have **independently**
built mobile plumbing, and a third effort — a planned reporter UI redesign —
will need the same plumbing again. Building a fourth hand-rolled shell would be
the third duplication of the same offline/sync/auth/networking machinery.

The two existing apps are **complementary**, not redundant, and that is the
whole reason a shared foundation is now worth extracting: one app has the
breadth (the skeleton) and the other has the depth on exactly the concerns the
first one stubbed.

### Source app A — amaru "FieldOps" (the skeleton, mature breadth)

`amaru.ca/apps/mobile/` — a roofing "Field Companion." KMP shared module +
native Android (Jetpack Compose) + native iOS (SwiftUI), plus a TypeScript
codegen package that projects the SMRT manifest into a narrow mobile contract.

- **Shared KMP module** — `apps/mobile/shared/`, namespace `ca.amaru.mobile.shared`,
  **40 Kotlin source files** across `api/`, `calculations/`, `compliance/`,
  `evidence/`, `fieldops/`, `packs/`, `sync/`, and 23 generated DTOs under
  `generated/`.
- **Design system** — `apps/mobile/androidApp/src/main/kotlin/ca/amaru/mobile/ui/FieldOpsTheme.kt`,
  a Compose Material3 theme whose tokens are **generic** (`FieldInk`,
  `FieldSurface`, `FieldCard`, `FieldOpsStatus.{Stop,Caution,Go,Info}`,
  `FieldOpsSpacing.{ScreenPadding,SectionGap,MinTouchTarget}`) — **zero roofing
  terms**. Glove-use spacing and status colors are directly reusable.
- **App shell + nav** — `FieldOpsShellState` / `FieldOpsNavigation` in
  `shared/.../fieldops/FieldOpsNavigation.kt`. Navigation is **manual tabs**
  (`NavigationBar` on Android, `TabView` on iOS); **no `androidx.navigation`**.
- **Offline pack lifecycle** — immutable snapshot + **SHA-256 integrity check**
  (`packs/PackIntegrityCheck.verifyManifestHash()`, `hashAlgorithm = "sha256"`)
  + a **`PackTextResolver`** i18n resolver with a requested→fallback→source
  locale chain (`packs/PackTextResolver.kt`). Sophisticated and generic.
- **Evidence/media capture** — SHA-256 asset hashing
  (`EvidenceCaptureAssetRef.sha256`) + a geo **location sidecar**
  (`EvidenceLocationMetadata` with lat/long/accuracy/permission status).
- **Native adapters (Android)** — ML Kit barcode
  (`AndroidBarcodeScanner.kt`), speech
  (`AndroidFieldOpsSpeechRecognizer.kt`), and on-device LLM via ML Kit GenAI
  Prompt API / **Gemini Nano** (`AndroidFieldOpsTalkAdapter.kt`, with FieldOps
  API fallback). Barcode and speech are ready as-is on Android.
- **Build scaffold** — KMP Gradle (`androidTarget` + `iosX64/iosArm64/iosSimulatorArm64`),
  **XcodeGen** (`iosApp/project.yml`), a CI-safe `scripts/validate-mobile-shell.mjs`
  (checks structure without Android SDK / Xcode), and **contract codegen**:
  `manifest.json → mobile-object-allowlist.json → mobile-contract.json → generated/*.kt`
  (`packages/amaru-mobile-contract/`).

**What looks done but isn't** — the survey found three load-bearing gaps behind
amaru's breadth:

1. **Offline pack store and sync queue are in-memory only.**
   `packs/OfflinePackStore.kt` is `InMemoryOfflinePackStore` backed by
   `private val packs = mutableMapOf<…>()`; `sync/FieldSyncQueue.kt` is backed
   by `private val events = mutableListOf<SyncEventDto>()`. **No SQLite /
   DataStore / Room / file backing** — everything is lost on process death. For
   an app whose entire premise is offline field work, this is the #1 gap.
2. **No auth/session at all.** No bearer token, no OIDC, no PKCE, no session
   anywhere in the KMP or native code. `tenantId` and `deviceId` are passed as
   **plain string parameters** (`FieldSyncQueue.enqueue(tenantId, deviceId, …)`),
   and the Android HTTP client
   (`platform/AndroidFieldOpsApiClient.kt`) sets only `Accept` /
   `Content-Type` headers — **no `Authorization`**.
3. **iOS bridges don't link the shared framework.** `iosApp/Amaru/Platform/PackDownloaderBridge.swift`
   returns `RoofingPackSummaryViewModel.sample` (hardcoded), commented "Until
   full Xcode setup is active…" — it never calls `AmaruShared`. iOS also has
   **no extracted theme** (an inline `FieldOpsStyle` enum lives in
   `Screens/FieldOpsShellView.swift`) and **no barcode scanner**.

Two lesser nuances: amaru uses **plain Kotlin interfaces, not KMP
`expect`/`actual`**, for its adapters, and it has shared interfaces only for
**evidence capture** (`EvidenceCapturePlatformAdapter`) and **pack API**
(`ProjectPackApiClient`) — there is **no shared interface for barcode, speech,
or on-device LLM** (Android has concrete impls with no shared contract).

### Source app B — anytown "reporter" (the hardened organs, narrow depth)

`anytown.ai/apps/reporter-mobile/` (on unpushed branch
`claude/anytown-reporter-mobile-shell`) — a civic event reporter. Deliberately
lean: a shared KMP contract module, a single plain-Views Android
`MainActivity.kt`, and a SwiftUI iOS app. It has almost none of amaru's breadth,
but it is **review-cycle hardened on exactly amaru's three gaps**:

1. **Durable, file-backed offline write-queue.** `iosApp/AnytownReporter/AnytownReporterApp.swift`
   `ContributionStore` persists a `queue.json` under Application Support
   (Android mirror: `MainActivity.kt` writes `filesDir/reporter-captures/queue.json`).
   State machine `pending → uploading → synced → failed`
   (`enum ContributionSyncState`); **coalesced flush** (single-flight via
   `NSLock` / `AtomicBoolean`) triggered on **foreground (`onResume`),
   connectivity regained (network callback), and manual retry**; **terminal-failed
   cap** (`contributionMaxAttempts = 5`, then `failed` and excluded from
   auto-flush); **idempotency key** = a per-entry UUID; and **crash-safety** —
   on load, any `uploading` entry is reset to `pending` so an interrupted upload
   re-sends rather than being lost.
2. **Real PKCE/OIDC auth.** `POST /api/mobile/auth/start` → `{authorizationUrl,
   state, codeVerifier}`, browser hand-off, **deep-link redirect**
   (`ai.anytown.reporter://auth`), `POST /api/mobile/auth/complete` → bearer,
   `GET /api/mobile/session` bootstrap, and **401 → clear token → re-auth**.
   State is validated; the code verifier is persisted for the exchange.
3. **Production networking.** Every request carries `Authorization: Bearer …`;
   evidence uploads use streamed **multipart/form-data**
   (`postMultipart(...)`, chunked, boundary-framed); **retry** with the same
   attempt-cap semantics as the queue. (Transport is raw `HttpURLConnection` /
   `URLSession` — see the "productionize" note below.)

Reporter also carries two patterns amaru lacks: a **single-tap capture** flow (a
schema-driven tile grid → optimistic local log entry with frozen `capturedAt` →
off-thread POST → **Undo/soft-retract** via local-remove-if-unsynced or
`DELETE` if synced), and an **event-awareness** flow. It carries **no copy of
amaru's theme/pack/shell plumbing** — the two apps overlap **zero** in code, so
extraction merges rather than de-conflicts.

### The core finding

**amaru is the skeleton; reporter is the organs.** amaru's three "done but not
really" gaps map one-to-one onto reporter's three hardened strengths. Neither
app alone is a foundation; together they are. The decision below graduates the
generic union of the two into shared SMRT libraries.

## Decision

Create a **three-library mobile foundation** in SMRT, seeded from amaru's
skeleton and hardened with reporter's organs, plus a **supporting codegen build
tool**. Logic is written once and shared; UI is inherently per-platform, so the
split falls on the logic/UI seam.

### 1. `smrt-mobile` — KMP shared logic (one module)

The crown jewel. Kotlin Multiplatform `commonMain`, consumed by Android directly
and by iOS via the exported framework. Contains everything that is not a
platform view:

- DTOs / mobile contract (from codegen)
- **Durable** offline pack store + sync/write queue (amaru's data model &
  integrity, backed by reporter's durability, productionized to a real store)
- Auth/session (PKCE/OIDC → bearer, deep-link contract, 401 re-auth)
- Networking client (auth headers + multipart + retry)
- Evidence-capture model (SHA-256 + geo sidecar)
- i18n resolver (`PackTextResolver`)
- App-shell / nav **state** (`FieldOpsShellState`-style)
- Platform-adapter **interfaces** (evidence, pack API, **and the missing
  barcode/speech/LLM contracts**)
- On-device-LLM abstraction (interface; platform-specific providers)

### 2. `smrt-android` — Compose design system + UI foundation

The generic theme/tokens (`FieldOpsTheme`), app-shell widgets (bottom-tab
scaffold), reusable components, and **native platform adapters** (ML Kit
barcode, speech, camera, Gemini Nano). Consumes `smrt-mobile` directly.

### 3. `smrt-ios` — SwiftUI design system + UI foundation

A SwiftUI theme (extracted from amaru's inline `FieldOpsStyle` into a real
file), shell widgets, and native adapters (camera, evidence, Foundation Models
LLM, **and a net-new barcode scanner**), **consuming the exported KMP
framework** (which amaru's iOS never wired up).

### Supporting: `smrt-mobile-contract` (codegen build tool)

The generic version of `amaru-mobile-contract`: `manifest → allowlist →
contract → Kotlin/Swift DTOs`. This is a TypeScript package (like the rest of
`packages/`) and the natural bridge between the SMRT manifest and the KMP
module. The trade-parameterized codegen — not a committed per-trade stub — is
what proves the multi-consumer pattern (see [Correction 3](#corrections-to-the-original-survey-brief)).

### Why this cut

Logic (DTOs, offline queue, auth, networking, evidence) is **platform-agnostic
and expensive to get right** — it is written once in `smrt-mobile`. UI is
**inherently per-platform** — a Compose theme and a SwiftUI theme cannot be the
same artifact — so the design system unavoidably splits into `smrt-android` and
`smrt-ios`. The seam between library 1 and libraries 2/3 is exactly the seam
between "shared once" and "native per platform." We keep native SwiftUI on iOS
rather than Compose Multiplatform (see [Alternatives](#alternatives-considered)).

## Per-concern source-of-truth

Each generic concern, where it is seeded from, and where it lands. Verified
against both codebases; the `Note` column flags where the target must
**productionize, not lift**.

| Concern | Seed from | Target lib | Note |
|---|---|---|---|
| Design system / theme | amaru `FieldOpsTheme.kt` | `smrt-android` (+ build the missing iOS theme file) | Tokens are generic (`FieldInk`/`FieldSurface`/`FieldOpsStatus`); zero roofing terms |
| App shell + nav **state** | amaru `FieldOpsShellState` / `FieldOpsNavigation` | `smrt-mobile` (state) + `smrt-android`/`smrt-ios` (widgets) | Manual tabs; no `androidx.navigation` |
| Shared KMP module (DTOs, packs, evidence, i18n) | amaru `shared/` (40 files, `ca.amaru.mobile.shared`) | `smrt-mobile` | The crown jewel |
| Platform-adapter pattern | amaru (plain interfaces, **not** `expect`/`actual`) | `smrt-mobile` (ifaces) + platform libs | **Add the missing barcode/speech/LLM shared interfaces** — amaru has none |
| Offline PACK lifecycle (immutable snapshot + SHA-256 + `PackTextResolver`) | amaru `packs/` | `smrt-mobile` | Sophisticated, generic; keep as-is |
| Barcode / Speech / on-device LLM (ML Kit, Gemini Nano / Foundation Models) | amaru `AndroidBarcodeScanner` / `…SpeechRecognizer` / `…TalkAdapter` | `smrt-android`/`smrt-ios` (+ `smrt-mobile` LLM iface) | Android ready as-is; iOS barcode is net-new |
| Media/evidence capture (SHA-256, geo sidecar) | amaru `EvidenceCapture` + reporter `LocationPurpose` | `smrt-mobile` + platform | Merge. **Reporter has no EXIF** (see Correction 2) |
| KMP/XcodeGen/validate-shell scaffold + contract codegen | amaru scaffold + `amaru-mobile-contract` | `smrt-mobile-contract` + project template | `manifest → allowlist → Kotlin DTO`; trade-parameterized |
| **Durable offline write-queue** | **reporter** (durability) + amaru (data model/integrity) | `smrt-mobile` (+ durable store, e.g. SQLDelight) | **amaru's #1 gap = reporter's #1 strength** |
| **Auth / session (PKCE/OIDC → bearer, deep-link)** | **reporter** | `smrt-mobile` + platform browser/deep-link | **Net-new for amaru** |
| **Production networking (auth + multipart + retry)** | **reporter** | `smrt-mobile` (KMP Ktor client) | **Replaces both apps' raw HttpURLConnection/URLSession** |
| Single-tap capture pattern | reporter | app-level pattern; generic bits in `smrt-mobile` | Schema-driven tiles → optimistic log → Undo/soft-retract; domain stays in-app |
| Event-awareness ranking | reporter | **app-level + server-side** | See Correction 1 — ranking is **server-side**; only the ranked-list UI is client |

## "Productionize, not lift" — non-negotiable caveats

Several seeds are prototypes. Extraction must upgrade them, not copy them:

- **In-memory → durable.** amaru's `mutableMapOf` / `mutableListOf` stores must
  become a real durable store (**SQLDelight** is the natural KMP-common choice)
  carrying reporter's `pending/uploading/synced/failed` + crash-recovery
  (`uploading → pending` on load) + attempt-cap + idempotency semantics.
- **Net-new auth.** Auth is entirely reporter's; amaru contributes nothing here.
  The PKCE/OIDC flow, deep-link contract, and 401-reauth must be lifted from
  reporter and generalized (provider-agnostic endpoints, configurable scheme).
- **iOS framework wiring.** amaru's iOS bridges return sample data and never
  link `AmaruShared`. `smrt-ios` must **actually export and consume** the KMP
  framework — this is unbuilt in both apps' iOS and is the riskiest single item.
- **Transport upgrade.** Both apps use raw `HttpURLConnection` / `URLSession`.
  The shared client should be a **KMP Ktor** client so networking is written
  once in `commonMain`, not twice natively.
- **Distribution/packaging is unsolved.** `smrt-mobile`/`smrt-android` are
  Gradle/Maven artifacts and `smrt-ios` is an SPM/XCFramework artifact — **none
  are npm packages**. How they live in a pnpm/turbo monorepo and how consumers
  install them (Maven Central vs GitHub Packages Maven vs git-source SPM) is an
  open decision the plan's Phase 1 must resolve. amaru's precedent — a
  `package.json` wrapper running Gradle via turbo, TS codegen as a real npm
  package — is the starting point.

## Consequences

### Positive

- Future mobile apps (starting with the reporter UI redesign) build on a real
  foundation instead of a third hand-rolled shell.
- The single highest-risk concern (durable offline sync) is written and hardened
  **once**, by the team that already hardened it in reporter.
- SMRT's manifest/codegen story extends to mobile: the same
  `@smrt()`-decorated objects that generate REST/CLI/MCP also project into a
  typed mobile contract.
- Trade/tenant-neutrality is provable — rebuilding **both** amaru and reporter on
  the foundation (Phase 7) is the acceptance test.

### Negative / costs

- SMRT gains its **first non-TypeScript packages** — Kotlin + Swift toolchains,
  Gradle/XcodeGen, and mobile CI (even the CI-safe `validate-shell` path) are
  new surface area for a TS-first monorepo and its maintainers.
- Three libraries + a codegen package is more moving parts than one; the
  logic/UI split means a single feature can touch `smrt-mobile` **and**
  `smrt-android` **and** `smrt-ios`.
- Packaging/distribution for non-npm artifacts is genuinely unsolved (above).
- Two of the three "organs" (durable store productionization, iOS framework
  wiring) are **upgrades**, not lifts — real engineering, not copy-paste.

### Risks

- **iOS KMP-framework export** is unproven in both source apps; if it fights the
  toolchain, `smrt-ios` slips.
- **Coupling to SMRT server contracts** — the mobile contract pins to manifest
  shape and to `/api/mobile/*` endpoints that must exist server-side.
- Introducing mobile CI could slow the pipeline; keep the SDK-free
  `validate-shell` as the default gate and make full device builds opt-in.

## Alternatives considered

1. **Single `smrt-mobile` library only (no `smrt-android`/`smrt-ios`).**
   Rejected: a Compose theme and a SwiftUI theme are different artifacts in
   different languages — they cannot share one module. Folding native UI into
   the KMP module either forces Compose Multiplatform (see below) or produces a
   grab-bag module mixing `commonMain` logic with Android-only view code.
   Keeping the split honors the real logic/UI seam.
2. **Compose Multiplatform to share UI too.** Rejected (for now). The epic chose
   the "Amaru strategy" — **native SwiftUI on iOS**. amaru already invested in a
   SwiftUI shell and Foundation Models integration; CMP on iOS is still maturing
   for deep native integration (camera, ML Kit/Foundation Models, deep links),
   and it would throw away amaru's SwiftUI work. We keep UI native and share
   only logic. Revisit if iOS UI duplication becomes the dominant cost.
3. **Do nothing / copy per app.** Rejected: this is already the *third* time the
   same offline/sync/auth/networking plumbing is needed. amaru proved the
   breadth is generic; reporter proved the depth is generic; a third hand-roll
   would re-pay both costs and re-introduce amaru's three gaps.
4. **A full RFC instead of an ADR.** The `rfcs/` specs
   (e.g. [RFC-001](../rfcs/RFC-001-multi-tenancy.md)) design an entire package's
   API surface up front. Here the *decision* — extract a three-library
   foundation from two proven apps — is what needs recording now; the detailed
   per-object API is discovered during phased extraction. An ADR + companion
   plan is the right weight; a per-package spec (RFC) can follow if a specific
   library's surface warrants one.

## Phased extraction order

Productionize, don't lift. Full task breakdown, acceptance criteria, and
pick-up-Phase-1 detail live in the companion
[extraction plan](./0001-kmp-mobile-foundation-extraction-plan.md). Summary:

1. **`smrt-mobile` skeleton** ← amaru `shared/` + the KMP/XcodeGen/validate +
   codegen scaffold. Resolve monorepo placement & distribution first.
2. **Durable offline queue + evidence model** ← amaru model/integrity backed by
   reporter's durability, productionized to SQLDelight. **Highest leverage.**
3. **Auth/session** ← reporter PKCE/OIDC as a shared module + platform
   browser/deep-link.
   - **3.5 (added by the Phase 0 owner decision): server-side `/api/mobile/*`
     handlers in `smrt-users`** (#1748) — SMRT ships the auth + session +
     upload-contract server surface itself (anytown's dashboard, which
     already implements it on smrt-users OIDC/session infra, is the
     reference implementation and migrates in Phase 7).
4. **Networking** ← KMP Ktor client carrying reporter's auth + multipart + retry.
5. **`smrt-android`** ← amaru theme + shell + barcode/speech/Talk adapters.
6. **`smrt-ios`** ← extract amaru's inline theme into a real file, **wire the
   shared framework** (amaru's bridges are stubbed), port adapters, add barcode.
7. **Rebuild both reporter and amaru** on the foundation — two reference
   consumers prove trade-neutrality.

## Corrections to the original survey brief

Recorded for provenance; each was verified against source before writing.

1. **Event-awareness ranking is server-side, not client-side.** In reporter,
   `GET /api/mobile/events/nearby?lat=&lng=&at=` returns **pre-ranked**
   candidates (`rankScore`, highest first); the client only renders the top
   candidate as a banner and groups the rest (`MainActivity.kt` ~L709,
   "Candidates arrive ranked… the first is best"). There is no client-side
   ranking algorithm to extract — only a ranked-list UI. The generic reusable
   piece is the *contract*, not a ranker.
2. **Reporter has `LocationPurpose` but no EXIF handling.** `LocationPurpose`
   (iOS) / `PendingLocationAction` (Android) enums disambiguate which flow
   requested a fix — real and useful. But images are JPEG-recompressed
   (`jpegData(0.8)` / `compress(JPEG, 85)`), which **strips EXIF**; geo is
   persisted as **separate JSON `latitude`/`longitude` fields**, not embedded in
   image metadata. The per-concern table reflects this.
3. **amaru's `tectum-mobile-contract` is not a committed dormant package.** In
   the amaru.ca working tree, `packages/tectum-mobile-contract/` contains **only
   untracked `.turbo/` build logs** (nothing git-tracked; no `package.json`,
   `src/`, or `generated/`), and those logs reference a **separate `tectum.ai`
   repo that is not present on this machine**. Only `amaru-mobile-contract` is a
   real package here. The multi-trade pattern is proven instead by the
   trade-parameterized shared script (`scripts/generate-mobile-contract.mjs`)
   and the `<trade>-mobile-contract` naming convention — which is exactly the
   generalization `smrt-mobile-contract` should adopt.
4. **amaru uses plain interfaces, not KMP `expect`/`actual`, and lacks shared
   barcode/speech/LLM interfaces.** Shared contracts exist only for evidence
   capture and pack API; barcode/speech/LLM have Android impls with **no shared
   interface**. `smrt-mobile` must *add* these interfaces, not just relocate
   existing ones.

## References — verifiable source paths

**amaru** (repo `amaru.ca`; paths below are relative to the repo root):
- `apps/mobile/shared/` — KMP module (`ca.amaru.mobile.shared`, 40 files)
- `apps/mobile/shared/src/commonMain/kotlin/packs/OfflinePackStore.kt` — `InMemoryOfflinePackStore`
- `apps/mobile/shared/src/commonMain/kotlin/sync/FieldSyncQueue.kt` — in-memory queue
- `apps/mobile/shared/src/commonMain/kotlin/packs/PackIntegrityCheck.kt` — SHA-256
- `apps/mobile/shared/src/commonMain/kotlin/packs/PackTextResolver.kt` — i18n
- `apps/mobile/shared/src/commonMain/kotlin/evidence/EvidenceCapture.kt` — evidence model + adapter iface
- `apps/mobile/shared/src/commonMain/kotlin/fieldops/FieldOpsNavigation.kt` — `FieldOpsShellState`
- `apps/mobile/androidApp/src/main/kotlin/ca/amaru/mobile/ui/FieldOpsTheme.kt` — design tokens
- `apps/mobile/androidApp/src/main/kotlin/ca/amaru/mobile/platform/AndroidFieldOpsApiClient.kt` — no-auth client
- `apps/mobile/androidApp/src/main/kotlin/ca/amaru/mobile/platform/AndroidBarcodeScanner.kt` — ML Kit
- `apps/mobile/androidApp/src/main/kotlin/ca/amaru/mobile/platform/AndroidFieldOpsTalkAdapter.kt` — Gemini Nano
- `apps/mobile/iosApp/Amaru/Platform/PackDownloaderBridge.swift` — returns `.sample` (stub)
- `apps/mobile/iosApp/Amaru/Screens/FieldOpsShellView.swift` — inline `FieldOpsStyle`
- `apps/mobile/iosApp/project.yml` — XcodeGen spec
- `packages/amaru-mobile-contract/` — codegen (`generate-kotlin.ts`, `mobile-object-allowlist.json`, `generated/mobile-contract.json`)
- `scripts/generate-mobile-contract.mjs`, `scripts/validate-mobile-shell.mjs`

**anytown reporter** (repo `anytown.ai`, branch `claude/anytown-reporter-mobile-shell`; paths below are relative to the repo root):
- `apps/reporter-mobile/iosApp/AnytownReporter/AnytownReporterApp.swift` — `ContributionStore` durable queue, PKCE, multipart, single-tap capture (`enum ContributionSyncState`, `contributionMaxAttempts = 5`)
- `apps/reporter-mobile/androidApp/src/main/kotlin/ai/anytown/reporter/MainActivity.kt` — Android mirror (queue at `filesDir/reporter-captures/queue.json`, `/api/mobile/auth/*`, `postMultipart`, tile grid + Undo)
- `apps/reporter-mobile/shared/src/commonMain/kotlin/ai/anytown/reporter/` — `ReporterClient.kt`, `DeviceCapabilities.kt`, `generated/Contract.kt`
- `apps/reporter-mobile/scripts/` — `validate-shell.mjs`, `validate-android.mjs`, `validate-ios.mjs`
