# ADR 0001 — Extraction Plan (companion)

Companion to [ADR 0001: A Reusable KMP Mobile Foundation](./0001-kmp-mobile-foundation.md).
This is the phased task breakdown so a follow-up session can pick up **Phase 1**
cold. Read the ADR first for the decision and the "productionize, not lift"
caveats — every phase below inherits them.

**Governing rule:** *productionize, don't lift.* Where a seed is a prototype
(in-memory store, no auth, stubbed iOS), the phase upgrades it. Copy-paste is a
bug, not a shortcut.

**Naming:** `@happyvertical/smrt-mobile` (KMP), `@happyvertical/smrt-android`
(Compose), `@happyvertical/smrt-ios` (SwiftUI/SPM), `@happyvertical/smrt-mobile-contract`
(TS codegen). Final npm/Maven/SPM coordinates are a Phase 1 deliverable.

**No package scaffolding has been created yet.** This branch is ADR + plan only.
Adding a live package to the pnpm/turbo workspace pulls in workspace resolution,
knowledge-check freshness, DAG guardrails, and coverage gates — not trivial and
out of scope for a docs PR. Phase 1 creates the first real package.

---

## Phase 0 — Decisions to lock before writing code

These block Phase 1 and are genuine forks, not defaults:

- **Monorepo placement.** `packages/smrt-mobile` (alongside TS packages, Gradle
  orchestrated by turbo via a `package.json` wrapper — amaru's precedent) vs a
  new top-level `mobile/`. Recommendation: follow amaru — `packages/` with a
  `package.json` wrapper that shells Gradle, so turbo/knowledge tooling still
  sees it.
- **Distribution.** `smrt-mobile`/`smrt-android` → Maven (Maven Central vs
  GitHub Packages Maven); `smrt-ios` → SPM (XCFramework vs source). Consumers
  are on local fs today ([ergot/anytown are the only external consumers]), so a
  git-source/`workspace` path is viable for v0.
- **Durable store.** Confirm **SQLDelight** (KMP-common, typed) vs
  DataStore/raw-file. ADR assumes SQLDelight.
- **CI posture.** Default gate = SDK-free `validate-shell`; full device builds
  (Gradle assemble / xcodebuild) opt-in/nightly to keep the PR pipeline fast.
- **Server contract.** Confirm `/api/mobile/*` (auth + upload + session)
  endpoints exist or are planned server-side; the mobile contract pins to them.

**Exit:** placement, distribution, store, and CI posture written into Phase 1's
package README; server-contract owner identified.

## Phase 1 — `smrt-mobile` skeleton

**Goal:** a buildable, empty-but-real KMP shared module + the codegen bridge,
with the CI-safe validate path green.

**Seed:** amaru `apps/mobile/shared/` structure; `packages/amaru-mobile-contract/`;
`scripts/{generate-mobile-contract,validate-mobile-shell}.mjs`;
`apps/mobile/iosApp/project.yml`.

**Tasks:**
- Create `packages/smrt-mobile` — KMP Gradle module targeting
  `androidTarget` + `iosX64/iosArm64/iosSimulatorArm64`; `package.json` wrapper
  running Gradle through turbo; module namespace `com.happyvertical.smrt.mobile`
  (final name TBD).
- Create `packages/smrt-mobile-contract` — generalize `amaru-mobile-contract`'s
  `manifest → allowlist → mobile-contract.json → generated Kotlin (+ Swift)`
  pipeline; **trade/tenant-parameterized** (the generalization of the
  `<trade>-mobile-contract` naming). Emit both Kotlin DTOs (for KMP) and Swift
  DTOs (reporter already generates `MobileContract.swift`).
- Port amaru's generic, already-good pieces **as-is**: `PackTextResolver`,
  `PackIntegrityCheck` (SHA-256), pack snapshot model, evidence model, shell/nav
  **state** (`FieldOpsShellState` → `MobileShellState`).
- Port `validate-mobile-shell.mjs` → `smrt-mobile`'s CI gate.
- Add the package `AGENTS.md` (+ `CLAUDE.md` `@AGENTS.md` shim) per repo
  convention; wire knowledge-check.

**Acceptance:** `pnpm --filter @happyvertical/smrt-mobile build` compiles the KMP
module; codegen round-trips a sample manifest; `validate:shell` passes on CI
without Android SDK/Xcode; knowledge-check green.

**Do NOT** port the in-memory stores or the no-auth client — Phases 2–4 replace
them.

## Phase 2 — Durable offline queue + evidence model (highest leverage)

**Goal:** the single most valuable organ — a durable, crash-safe offline
write-queue — living in `commonMain`.

**Seed:** reporter `ContributionStore` (durability, state machine, coalesce,
cap, idempotency, `uploading→pending` recovery) + amaru evidence model & SHA-256
integrity. **Replace** amaru's `InMemoryOfflinePackStore` / `FieldSyncQueue`.

**Tasks:**
- Model the queue on a **SQLDelight** schema: item id (UUID = idempotency key),
  payload, `state ∈ {pending,uploading,synced,failed}`, `attemptCount`,
  timestamps.
- Port semantics: **single-flight coalesced flush**; triggers = foreground /
  connectivity / manual retry (expose as an interface the platform layers call);
  **terminal cap** (`maxAttempts`, default 5) → `failed`, excluded from
  auto-flush; **crash recovery** — reset `uploading→pending` on load.
- Fold in the evidence model: SHA-256 asset hashing + `EvidenceLocationMetadata`
  geo sidecar (note: geo is a sidecar field, **not** EXIF — see ADR Correction 2).
- Unit tests: enqueue→flush→synced; retry→cap→failed; crash mid-upload→re-send;
  idempotent re-POST.

**Acceptance:** queue survives simulated process death (persisted rows reload,
`uploading` reset to `pending`); attempt-cap and coalescing covered by tests;
no in-memory-only store remains.

## Phase 3 — Auth / session

**Goal:** provider-agnostic PKCE/OIDC session in `commonMain` + thin platform
browser/deep-link seams. **Net-new for amaru.**

**Seed:** reporter auth (`/api/mobile/auth/{start,complete}`, `/api/mobile/session`,
`codeVerifier`/`state`, deep-link `…://auth`, 401→re-auth).

**Tasks:**
- Shared session manager: start → (platform opens browser) → deep-link redirect
  → complete → bearer; persist token securely (Keychain/Keystore via platform
  seam); **401 → clear → re-auth** hook consumed by the networking client.
- Generalize: configurable provider id, redirect scheme, and endpoint base
  (drop `ai.anytown.reporter`-specific constants).
- Platform seams: Android custom-tab + intent-filter deep link; iOS
  `ASWebAuthenticationSession` + URL scheme.

**Acceptance:** full PKCE round-trip against a test IdP; token persists across
launch; a forced 401 drives re-auth.

## Phase 4 — Networking (KMP Ktor client)

**Goal:** one shared HTTP client, replacing both apps' raw
`HttpURLConnection`/`URLSession`.

**Seed:** reporter networking semantics (auth header, multipart upload, retry).

**Tasks:**
- **KMP Ktor** client in `commonMain`: inject bearer from Phase 3; **multipart**
  upload for evidence/media; **retry** aligned with the Phase 2 attempt-cap;
  401 → Phase 3 re-auth hook.
- Wire the Phase 2 queue's flush to POST through this client.

**Acceptance:** multipart evidence upload succeeds against a test endpoint;
auth header present on every request; retry/backoff covered; queue flush uses
the Ktor client end-to-end.

## Phase 5 — `smrt-android`

**Goal:** the Compose design system + native adapters.

**Seed:** amaru `FieldOpsTheme.kt` (generic tokens), shell widgets,
`AndroidBarcodeScanner` (ML Kit), `AndroidFieldOpsSpeechRecognizer`,
`AndroidFieldOpsTalkAdapter` (Gemini Nano).

**Tasks:**
- Port theme/tokens → `MobileTheme` (rename generically; keep `Status`/spacing
  scales).
- Port bottom-tab shell scaffold bound to `MobileShellState`.
- Port barcode/speech/Talk adapters as concrete impls of the **new shared
  interfaces** added in `smrt-mobile` (barcode/speech/LLM contracts don't exist
  in amaru's shared layer — ADR Correction 4).

**Acceptance:** Android sample app renders the shell using `smrt-android` +
`smrt-mobile`; barcode/speech work on-device; `validate-android` green.

## Phase 6 — `smrt-ios`

**Goal:** SwiftUI design system + adapters **actually consuming the exported KMP
framework**. Riskiest phase.

**Seed:** amaru inline `FieldOpsStyle` (extract to a real file), SwiftUI shell,
`EvidenceCaptureBridge`, `FieldOpsTalkBridge` (Foundation Models). **amaru's iOS
bridges are stubbed (`PackDownloaderBridge` returns `.sample`) and must be
replaced with real framework calls.**

**Tasks:**
- **Export the KMP framework** and wire the iOS module to consume it (this is
  unbuilt in both source apps — de-risk early with a spike).
- Extract inline `FieldOpsStyle` → a real `MobileTheme.swift`.
- Port evidence/Talk bridges as real KMP-backed impls; **add a net-new barcode
  scanner** (amaru iOS has none).

**Acceptance:** iOS sample app drives real shared logic (no `.sample` stubs);
theme is a real file; barcode scans; `validate-ios` green (XcodeGen + typecheck
+ simulator build).

## Phase 7 — Rebuild both reference consumers

**Goal:** prove trade/tenant-neutrality by rebuilding **both** apps on the
foundation.

**Tasks:**
- Rebuild reporter screens (single-tap capture, event-awareness UI) on
  `smrt-mobile`/`android`/`ios`; keep domain (stat schemas, civic events)
  in-app.
- Rebuild amaru FieldOps screens on the foundation; keep roofing domain in-app.
- Delete the duplicated plumbing from both apps.

**Acceptance:** both apps run on the shared libraries with **zero** local copies
of queue/auth/networking/theme; the only app-local code is domain + screens.
Two consumers from different trades = trade-neutrality demonstrated.

---

## Dependency order

```
Phase 0 (decisions)
      │
Phase 1 (smrt-mobile skeleton + contract)
      │
      ├── Phase 2 (durable queue) ─┐
      ├── Phase 3 (auth) ──────────┤
      └── Phase 4 (networking) ────┘   (2→4 and 3→4: networking depends on both)
                     │
      ┌──────────────┴──────────────┐
Phase 5 (smrt-android)      Phase 6 (smrt-ios)   (parallel once 1–4 land)
      └──────────────┬──────────────┘
                Phase 7 (rebuild amaru + reporter)
```

Phase 2 is the highest-leverage single unit and can start immediately after
Phase 1. Phases 5 and 6 parallelize once the shared logic (1–4) is stable.

## Pick-up checklist for the next session (Phase 1)

1. Read [ADR 0001](./0001-kmp-mobile-foundation.md) end-to-end.
2. Resolve Phase 0 decisions (placement, distribution, store, CI, server
   contract) — use `AskUserQuestion` if any are genuinely the owner's call.
3. Study amaru `packages/amaru-mobile-contract/` and `apps/mobile/shared/`
   build files as the concrete template.
4. Scaffold `packages/smrt-mobile` + `packages/smrt-mobile-contract` with
   `package.json`, `AGENTS.md`, `CLAUDE.md` shim, Gradle/KMP config, and the
   `validate:shell` gate; get build + knowledge-check green **before** porting
   any logic.
