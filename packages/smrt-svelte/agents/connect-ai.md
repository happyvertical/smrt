# Connect AI (`./connect-ai`, `./connect-ai/server`)

`tool_host_policy` is an inference startup failure, not a signed-out state.
Connect AI shows its translated app-only-tools incompatibility, suppresses ready
and In use, and offers Check again. It never enables the CLI's built-in tools.

CLI readiness requires `ready === true` from inference's startup preflight,
not merely installed/signed-in or a stale top-level `configured` snapshot.
Both presentations and the onboarding `onchange` gate use this same condition.
Each engine is missing, signed out/unknown, installed-but-unusable with its fixed
reason, or preflighted ready. Only the last may say In use / assistant ready.
The native Codex compatibility/options evidence lives in inference's
[engine contract](../../inference/agents/engines.md#codex-01621-compatibility-evidence-and-owner-options).
Mounted tests refuse absent preflight even when `configured: true`; existing
positive sign-in fixtures explicitly complete preflight before selection.
Both presentations call that final state “Ready in this app”; compact hosts
retain the validated CLI version in the translated ready message. Installed and
signed-in alone is never the final readiness claim. Tricia delegates its state
GET to the shared route helper and supplements only host presentation metadata.

`ConnectAi` is a Provider-free, Svelte 5 onboarding step or settings panel. It
composes smrt-ui Button/Card/Badge and translated `ui.connect_ai.*` messages,
with token-only styling, heading/region names, live status, accessible errors,
external-link announcements and keyboard controls. It uses plain product names.
`variant="onboarding" | "settings"` shares the same engine policy; `onchange`
reports the selected engine's readiness to the host's next-step button.

```svelte
<script lang="ts">
  import { ConnectAi, createConnectAiClient } from '@happyvertical/smrt-svelte/connect-ai';
  const client = createConnectAiClient({ endpoint: '/api/connect-ai' });
</script>
<ConnectAi {client} apiKeyHref="/settings/inference" />
```

`apiKeyHref` points to the host's existing inference settings panel/controller
(`@happyvertical/smrt-inference/svelte`, `createInferenceSettingsController`).
That surface owns provider choice, key entry, origin binding and smrt-secrets
storage. Connect AI receives only `apiReady`; there is no second key form or
key storage API. Returning from settings/focusing the page refreshes status.
The component never reads or renders tokens, account credentials or upstream
errors. It translates fixed errors and only renders an inference-validated
ChatGPT authorization link, with another browser protocol/host guard. Installation
URLs come from inference's canonical CLI metadata. The existing `safeHref` guard
is reused for ordinary links.

A server route exports `mountConnectAiRoutes({ authorize, openBrowser? })`'s
`GET` and `POST`. `authorize(event)` is REQUIRED on every request/poll and must
verify authenticated owner, active tenant and settings permissions before returning
`ConnectAiServerBinding` (or `null` to refuse). It supplies the CURRENT principal's
stored `engine` read/`select` write, CLI service, ChatGPT connection and API status
resolver. Nothing binds a process-wide user. Pass the same stored preference to
chat's `createInferenceAssistantAdapters`; no engine preference schema is added.

GET projects a key-free `ConnectAiState` using inference's `inferenceEngineStatus`,
`createAgentCliService` status and login snapshots, connection status and host API
resolution. POST accepts `connect`, `select`, `chatgpt-start`, `chatgpt-sign-out`.
It enforces exact same-origin JSON, bounded bodies, known actions/engine/tool
values and live readiness before saving a selection. Every response is no-store.
Failures return fixed codes, never caught error text. Hosts supply their canonical
preference store; route code does not create model schema or write SQL.

CLI sign-in starts only the installed vendor CLI's OWN login. Unknown auth state
is a retry, not a login attempt. No in-app Claude subscription login is offered,
no CLI credential files/keychain are read or proxied, and ChatGPT is an opt-in
preview billed separately from an API key. The published preview limitations
link and legal note remain visible. ChatGPT sign-out leaves the selected engine
unconfigured; it never silently selects another billing path.

Desktop hosts may use inference's `openSystemBrowser` as `openBrowser`; the URL
is checked by `isChatGPTAuthorizationUrl` before opening. Without it, a normal
new-tab link is returned. The component polls only while sign-in is running,
refreshes on focus, serializes its requests and aborts/reclaims the timer and
listener on unmount. Hosts can supply `initialState` from a load function and
an injected client for tests/other authenticated transports. Browser entries
import inference contracts as types only; Node APIs stay on `./connect-ai/server`.

## Validation design

Tests use the package's jsdom harness on Node, fake connection/API states and
inference's vendor CLI fixtures; no real credentials, vendor login, containers,
database schema or new SQL dialect contract is introduced.

| Behavior/invariant | Trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | Edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Connection states | Mount onboarding/settings | Missing, installed signed-out/signed-in, key saved, readiness | Sign-in/status errors translated; unknown CLI retry | Host-authenticated user's snapshot | N/A: props/status only | jsdom/Node; no SQL | Inference status DTO | Component + axe | smrt-svelte test |
| Sign-in and polling | Human connect/select/sign-out | Real fixture vendor CLI login; fake plan start/poll/select | Missing tool, unready engine, upstream failure, foreign URL | Current owner/tenant via authorize | Existing host preference callback; no new transaction | Node subprocess/jsdom | Inference CLI/connection APIs | Route/component | smrt-svelte test |
| Authorization/CSRF | Status/action request | Current host binding used per request | Denied host, foreign origin, oversized/malformed/unknown action refused before mutation | Authorized versus denied owner/tenant binding | Host owns authorization and persistence | jsdom/Node; no SQL | Same-origin Fetch handler | Route | smrt-svelte test |
| Credential hygiene/lifecycle | Failure/unmount | No-store, bounded key-free projection, abort and timer cleanup | SDK/account/key text omitted; hostile URL refused | Authenticated browser | N/A: no credential persistence here | jsdom/Node | Browser/server transport | Unit/component | smrt-svelte test |

## Reuse check

MCP `review_smrt_project` reviewed chat and smrt-svelte; `build_context` architecture
query searched tool descriptions, engine adapters and Connect AI composition.
The configured server has architecture/model listings, no standalone component,
intent or recipe search. Read `docs/knowledge/intents/index.md` (AI, secrets, local
credentials, auth, approvals) and used `rg` by name AND purpose in smrt-ui,
smrt-svelte, chat, core, inference and app-shell: `ConnectAi`, `connect AI`,
`onboarding`, settings/status/sign-in/poll, API key, safe href and recipes.

| Introduced production file | Existing capability reused / why no existing file fits |
| --- | --- |
| `components/connect-ai/ConnectAi.svelte` | Ports shell's engine-connection composition to the owning shared Svelte layer; adopts smrt-ui primitives, i18n, safeHref and inference DTOs. Existing OwnerSetupForm creates the app owner, and InferenceSettingsPanel edits bindings/keys; neither composes vendor CLI and ChatGPT sign-in. No duplicate primitive or key form. |
| `components/connect-ai/client.ts` | Framework-neutral thin transport over the server mount, adapted from shell's onboarding client. No other shared transport provides these connection actions; no SvelteKit `$app` or shell global dependencies. |
| `components/connect-ai/server.ts` | Reuses inferenceEngineStatus, createAgentCliService, canonical CLI metadata, ChatGPTPlanConnection and URL validator. Shell mount is owner/model/runtime-specific; existing inference settings controller is reused for key saving but has no vendor CLI/plan action routes. Host authorizer/preference store remain external. Bounded JSON handling is local to this small Fetch route, not a new general HTTP layer. |
| `components/connect-ai/types.ts` | UI projection derives engine/tool/plan contracts from inference, with key-free fields only. Existing inference settings view types concern tiers/keys, not CLI/plan connection status. |
| `components/connect-ai/index.ts`, `i18n/strings.connect-ai.ts` | Export/catalog glue following existing package patterns; server snapshot builder registers the catalog. No model, recipe or MCP tool added. |

Tests reuse the established Svelte testing/axe harness and inference's
`installFakeCli`/`fakeDeps` fixtures. New helpers are test-local status fixtures
and request builders. Package DAG check confirms both new inference edges remain
acyclic. MCP's existing dependency/UI heuristic findings are not new copies.

## Integration exposure boundary

Connection setup is independent of cookbook model exposure and reference picker
sources. A tenant with no enabled models must still be able to connect AI before
onboarding creates its model offerings. The route regression installs a closed
core gate, verifies API readiness and selection, and proves no model exposure
lookup is used. No screen, picker, or cookbook module is changed.

Saved-product hosts can opt into `presentation="compact"` for the original
Tricia visual layout: ordered connection options, account/version
text is optional host-projected data, and a login started here selects its
engine after completion. Optional client `modelState`/`chooseModel` methods
connect the settings-only model picker to the host's existing preference.
Both presentations use the same serialized request/poll/abort lifecycle.
`./connect-ai/client` exposes the browser-safe transport and pure presentation
functions without importing a Svelte component (Node adapter tests can use it).
The route mount's `allowUnconfiguredApiSelection` and
`includeSignOutConfirmation` options preserve older host contracts; both default
false. Fresh/Skip, saved model validation and a sign-out fallback preference
remain host policy. No new key form, credential store, model or route file.

Compact host clients may additionally supply `connectOutcome` for their existing
ready/login/missing DTO and `errorMessage` to project fixed key-free errors. The
ordinary `connect(): Promise<void>` contract and default error policy stay
unchanged. Tricia uses these hooks for a CLI removed between status and click.

`./onboarding` composes this step with durable template selection; see
[host first-run contract](../../template-sveltekit/agents/onboarding.md).

An enclosing wizard may pass `headingId` to reference its existing heading.
The standard step then omits its own heading and keeps its labelled region;
standalone/settings and compact presentations retain their existing defaults.

## Startup readiness

Inference CLI status now carries optional `ready` and fixed-vocabulary
`startError`. Signed-in status alone never overrides a failed startup probe.
The probe starts the exact locked invocation with `--help` in a private empty
working directory, in the same sanitized process environment; it performs no
model request or credential mint. The existing 15-second detection cache owns
its lifetime. Connect AI projects only these safe fields and translates specific
runtime, invocation and directory failures; it neither renders provider output
nor offers a ready selection when the probe fails. The mounted tests cover all
three failures and accessible presentation. No new component/helper file.

## OpenAI route ordering and first-run follow-up

Both presentations now show Claude Code, ChatGPT (recommended OpenAI-plan sign-in),
Codex CLI (an existing-CLI alternative), then API key. Codex is no longer hidden
under Settings-only Advanced. Shared status/route preflight and strict `ready ===
true` remain unchanged; Tricia still consumes the canonical handler. Compatible
Codex no longer receives a version refusal. Tests cover both orders and wording,
ready/unready states, model preference, sign-in completion and Tricia composer refresh.
FirstRunOnboarding shows Settings only for a completed/restarted app, hides Skip
and its hint after readiness, and exposes `aiFooter` (a Svelte snippet) inside the
AI step card for the host's existing plugin Settings link. Reuse search found the
existing Card/snippet and wizard actions; no new component, route or transport.
