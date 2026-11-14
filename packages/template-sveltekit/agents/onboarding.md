# First run

## Browser QA follow-up test design

| Behavior/invariant | Trigger and positive case | Failure/negative case | Actor, executor and runtime | Contract edge and validation |
| --- | --- | --- | --- | --- |
| Review/decision is visible | Keyboard preview focuses and reveals review; apply reveals pending decision | Apply failure remains actionable, no success claim | Local owner, browser DOM; no SQL | Component regression and built-app keyboard proof |
| Single initial confirmation | Owner's server-stored unfinished first run and zero tenant list rows apply directly | Rows, restart, forged flags, changed preview or data arriving during activation retain/refuse approval shortcut | Owner/session ceiling; public collection counts on local SQLite; cookbook CAS | Core + real host regression; full package tests |
| Step navigation | One AI heading, visible step progress, back/keep-app controls | Pending writes cannot be abandoned | Authenticated browser; no SQL | Component tests and keyboard proof |
| Background | Full viewport in light/dark at desktop/phone widths | No differently colored area below short card | Browser theme tokens; no SQL | Built-app computed styles/screenshots |
| Settings | Visible explained switch and unsettled decisions | Completed/denied/failed outcomes never rendered here; failed save restores toggle | Owner, existing preference CAS and approval transport, SQLite | Component + product/browser tests |
| Introduction | Cookbook navigation order and labels, short supported help | No engine, unknown actions, technical model/tool vocabulary | Host-projected offerings; browser only | Host/component tests and built-app proof |

Reuse before edits: configured MCP reviewed core, smrt-svelte and template and
architecture context queried first-run emptiness, preview/focus, prebuilt settings,
owner decisions and introduction. Read the intent index; name/purpose `rg`
searched UI, Svelte, chat, core, preferences and template for step/progress,
focus/reveal, prebuilt toggles/settings, `isAppEmpty` and approval policies.
Extend existing onboarding/core contracts. New `PrebuiltComponentsSettings.svelte`
composes Toggle, Button, Card, existing approval card/transport and translated
messages; SettingsCatalog is a registry browser, not this preference editor.
Reuse Progress for the step indicator; native focus/instant scroll is needed for
headings (control `revealControl` always smooth-scrolls a form control).

Opt in with `createCookbookApplication({ onboarding: true, ... })`. Mount
`host.onboarding` as GET/POST `/api/onboarding`. The layout returns `onboarding`
and `assistantIntroduction`; an authenticated local owner sees the saved welcome,
AI, or template step until finished. A completed installation only enters the
picker again through the Settings confirmation. Completion remains durable while
that optional replacement is in progress.

`FirstRunOnboarding` from `smrt-svelte/onboarding` composes ConnectAi and chat's
existing owner approval card. Supply its authenticated clients and a completion
navigation callback. It owns no credential, cookbook mutation, or approval store.
API-key setup stays on the inference settings page; returning to onboarding
refreshes ConnectAi status. Step headings receive focus; controls use shared
primitives, translated messages and tokens; grids wrap on phones and use no motion.

An unconfigured host renders chat's `AiUnavailableNotice` with its existing
`unconfigured` reason and a Connect AI link. It does not mount AssistantDock,
its composer/polling, or the tool-derived greeting until an engine is connected.
Connected docks retain `aiSettingsHref` for a later unavailable response.

`host/onboarding.ts` persists owner/tenant progress using SQLite CAS in a separate
host system table. Its primary key is also the index for every query. Same-origin,
bounded JSON POST accepts only known actions and a current revision. Owner
membership is checked on every call; cookbook tool permissions are rechecked by
the canonical tool service. Preview labels come from the engine snapshot, including
layout overrides/hidden items. Apply regenerates the process-local preview token
and checks the original diff fingerprint/revision before applying. Unfinished first run counts the current cookbook list collections
through the tenant-scoped public collection API. With no rows, the explicit Use
confirmation applies directly; technical owner identity is not a person-facing
list. Populated apps and Settings restarts request a durable owner approval. Approval decisions use chat's existing route/continuation. A
successful terminal hold marks onboarding done on refresh, including after
restart. Failed/denied holds retain the step and require a fresh preview to retry.
No rows are deleted by template application; changed policies/navigation/recipes
are reviewed through the canonical preview, with owner approval for replacement.

## Test design

| Behavior / trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- |
| Welcome/AI advance | Engine first; explicit skip | Wrong step, unknown action rejected | Authenticated local owner | SQLite scoped CAS | Node 26 / HTTP | Component + host / package test |
| Resume/complete | Recreate helper at each step; done stays done | Stale revision cannot overwrite progress | Owner and tenant identity | One UPDATE CAS; failed action saves nothing | SQLite / Fetch | Host / template test |
| Preview/apply | Cookbook labels, durable hold, success after restart | Changed preview, apply failure, denied hold retry | Live owner/tool permission | Core CAS/audit + runtime approval continuation | SQLite / cookbook tools | Host + core / package test |
| Transport security | Same-origin owner | Anonymous, other tenant/non-owner, foreign origin, malformed/oversized body | Session bound, no body identity | No mutation on refusal | Local SQLite only | Host / template test |
| Accessible UI | Keyboard focus, labelled buttons, axe; phone wrapping | Retry remains on step | Browser owner | No SQL in component | jsdom / fake clients | Component / Svelte test |
| Working app | Yoga sections, named customer, stub assistant reads | No-engine inline prompt | Auto-claimed local owner | Product SQLite and generated REST | adapter-node / stub model | Product first-run smoke |

## Reuse check

Configured smrt-dev-mcp `review_smrt_project` on core, smrt-svelte and template;
`build_context` queried durable first run, ConnectAi, template preview/apply,
approval and lazy activation. This server has context/model inventories but no
standalone component/intent/recipe search endpoint. Read the intent index and
searched names AND purposes with `rg` in smrt-ui, smrt-svelte, chat, core,
inference and template: onboarding/first-run/wizard, template/listTemplates,
preview/approval/resume, settings/engine selection and cookbook nav labels.

| New production file | Existing implementation reused / reason |
| --- | --- |
| `host/onboarding.ts` | Composes core cookbook tools/engine snapshots, host SQLite and runtime owner approval continuation. OwnerSetupForm claims an owner; ConnectAi selects an engine; neither stores this first-run sequence. |
| `smrt-svelte/src/components/onboarding/FirstRunOnboarding.svelte` | ConnectAi, Button/Card/ConfirmDialog and AssistantApprovalCard; no duplicate wizard, engine form or authority. |
| `smrt-svelte/src/components/onboarding/OnboardingAssistant.svelte` | Existing AssistantDock/controller; adds a tool-derived first greeting and calm settings link. No new chat history or transport. |
| `smrt-svelte/src/components/onboarding/client.ts` | Follows ConnectAi's bounded same-origin route transport; this endpoint has different action/revision semantics. |
| `smrt-svelte/src/components/onboarding/types.ts` | Reuses AssistantApprovalView; defines only first-run progress/transport DTOs, not business models. |
| `smrt-svelte/src/components/onboarding/index.ts`, `i18n/strings.onboarding.ts` | Existing export and defineMessages catalog patterns. |
| `__tests__/onboarding.test.ts` | Reuses core's `getTestDatabase` and the existing host/ConnectAi request-fixture pattern. Its private event/read/change functions exercise this new revision-bound endpoint; no reusable first-run request fixture existed. |
| `smrt-svelte/src/components/onboarding/__tests__/FirstRunOnboarding.test.ts` | Reuses Testing Library, userEvent and UI's `expectNoA11yViolations`, as in ConnectAi tests. Its private fixture fakes the new first-run DTO/client plus the existing ConnectAi contract. |
| `smrt-svelte/src/components/onboarding/__tests__/OnboardingAssistant.test.ts` | Reuses cookbook's existing dock test fixture and actual AiUnavailableNotice; mocks only the dock to observe mount/transport behavior. |

Test-fixture searches used `rg` for `fixture`, `event`, `getTestDatabase` and
`expectNoA11yViolations` in the owning ConnectAi tests, cookbook host tests and
onboarding tests, alongside the first-run/approval searches above. These remain
test-local adapters rather than exported framework helpers.

Integration rebase `c8a329c455`: retain the host's public source-alias table and
Svelte runtime inference export; drop E2's duplicate generic alias commit.
Regenerate knowledge from the full build. The real host tests now recreate the
host between first-run apply and owner decision, prove Fresh closes REST/MCP and
navigation, and activate a template before exercising effective app Profile STI
creation, gated subtype refusal and Customer reference labels through REST.
Customer intentionally publishes read-only MCP; the test preserves that boundary.
The existing subclass, dispatcher and reference-picker implementations are reused.
The earlier rebase introduced no new production helper or component.

Browser QA #2 adds `PrebuiltComponentsSettings.svelte` in the owning Svelte
settings composition. It reuses Toggle/Button/Card and AssistantApprovalCard;
terminal outcomes stay in approval history. Its new test file uses existing
Testing Library/userEvent and UI axe helpers (searched those names in settings,
ConnectAi and onboarding tests). No new model, transport, store or test helper.
Preview and pending decisions receive native focus and instant scroll; step
progress uses UI Progress. ConnectAi accepts `headingId` to reuse its parent
heading. Greetings use the public pure workspace `applyShellLayout` projection
so lead lists follow the actual cookbook section ordering and wording, with
short sentences limited to offered actions. Backgrounds fill 100dvh with tokens.
