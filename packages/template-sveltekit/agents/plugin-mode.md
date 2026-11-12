# Local plugin mode

Mount `GET`/`POST = host.pluginMode` at `/api/plugin-mode`. The endpoint is local
single-owner only: direct loopback peer, exact Host, first-class owner session,
no bearer, exact Origin for writes and bounded JSON. GET returns secret-free
`PluginModeState`. POST accepts `{action:'connect'|'revoke',client:'codex'|
'claude-code'|'claude-desktop'}` or `{action:'embed',enabled:boolean}`. The layout's
`embed` is persistent per owner and tenant; pass it to existing CookbookApp.
Engine selection and embed updates preserve each other in the existing host store.

Connect rotates one holder in app-runtime's existing token store. The one-time
bearer goes directly into `saveCliConfig`'s private atomic file under the app
state root; it never enters HTML, a setup snippet, argv or a repository. The
adjacent generated launcher contains public paths/options only and invokes the
existing desktop `runLauncher({credentialPath})`. That mode verifies the saved
token in the same installation; it cannot mint a replacement after revocation.
Origin discovery and the health probe follow the existing launcher contract.
Each harness has an independent holder. Last seen uses the token store's existing
hour-granularity renewable-token usage timestamp (not a claim of an open socket).

The single `app.plugin` delegation permission is registered before owner seeding.
Only a token issued with that sole scope opts into plugin projection; broad owner
tokens retain their existing MCP contract even after their live permissions shrink.
The host reads original scopes from the existing token record, and verifies the
exact sole active local owner before delegation or credential issuance.
It means the current app tool surface, including future owner-published lists;
it grants no unrelated admin operation. On *each* verification the host binds the
token owner, reloads cookbook/preferences, resolves live owner permissions, and
intersects them with the assistant manifest + recipe/app service offerings. The
MCP plugin projection reuses `manifestToolToAITool` and `invokeManifestTool` for
exact assistant schema/operation parity. Wire aliases use the existing snake-case
converter. Ordinary operation-scoped MCP tokens keep their generated MCP surface
and package restrictions. Plugin delegation is explicit consent to the in-app
assistant surface, not a widening of ordinary MCP tokens. The existing outcome reader is also a principal-bound assistant extra tool,
`app.approvals` / `owner_approval_outcome`, when this requester has a hold. Both
transports call the same continuation reader, rechecking the original tool scope.
`PluginModeState.tools` exposes the actual assistant definitions and source
metadata to the signed-in local owner for parity inspection; no token is exposed.

All destructive model calls use the existing continuation authority. Native
recipe/app tools retain executor consumption. The owner-assigned credential label
prefixes the approval summary; a caller's claimed MCP name never supplies identity.
Held results say where to approve and return `approvalId`/`owner_approval_outcome`.
Approval consumes once before dispatch; repeated decisions/outcome reads do not
replay. As elsewhere, a crash during effects remains executing/unknown and needs
reconciliation; no transactional exactly-once external-effect guarantee is claimed.

The existing stdio bridge polls stateless tools/list every two seconds and emits
`tools/list_changed` on complete descriptor changes, invalidation and recovery.
It follows pagination, re-resolves credentials every request, redacts upstream
errors and stops its timer on close. The HTTP host remains stateless and uses the
existing private, zero-TTL catalog cache option so every discovery checks live
permissions and owner status.

## Setup and packaged apps

`generateLocalMcpSetup` in app-cli renders a shell-quoted `claude mcp add`, JSON for
Claude Desktop/`.mcp.json`, and Codex TOML. Each contains only the running app's
Node executable and generated private launcher path. Settings must explain that
the app stays open and that destructive calls wait in its approvals list.

A normal packaged app must retain app-cli and desktop as production dependencies.
The host uses `../bridge/smrt-mcp-bridge.mjs` beside its packaged `app/` directory,
plus the running bundled Node, and resolves the installed desktop launcher module.
No PATH lookup, checkout or globally installed Node is required. Source hosts
fall back to the installed app-cli bridge. Replacing/moving the installation may
require generating setup again so absolute executable/module paths are refreshed.

ChatGPT remote connectors cannot reach a person's loopback listener. The repo's
MCP Apps/OpenAI packages are view and server adapters, not a local ChatGPT executor.
The manifest generator also supports desktop-only distribution, but this app has
no verified ChatGPT desktop integration; Settings states that limit instead of
issuing a non-working local URL. Official desktop submission requires separate
organization access/review, not just a localhost connector.

## Test design

All new execution is Node 26, in-process SQLite; subprocesses are the real local
stdio bridge, never a provider/model or container. Commands are package `pnpm test`
and `pnpm typecheck`; the product adds built-app QA with the same launcher.

| Behavior/invariant | Reachable positive | Failure control | Actor/context; executor/transaction | Contract edge; test level |
| --- | --- | --- | --- | --- |
| Setup/credentials | Generated commands launch real bridge; token stays private | Foreign origin/anonymous/non-loopback/bearer/invalid/oversized body refused | First-class owner; existing token rotation transaction + atomic CLI file | JSON/TOML/shell; host integration + app-cli unit |
| Delegation | Same assistant operations, current and newly added lists | Narrow scopes, revoked token, disabled recipe/preference | Live owner/tenant; request principal and canonical dispatcher | MCP SDK stdio + HTTP; integration |
| Live catalog | Recipe enable and custom list change discovery | Closed preference removes recipe/provider tools | Same principal; existing cookbook/editor CAS publication | list_changed; integration |
| Approval | Held delete then owner decision and repeated outcome | Duplicate decisions refuse; existing authority covers denied/expired/foreign requester | Saved ceiling/args, canonical ApprovalService CAS then effect | Existing owner HTTP + continuation; integration |
| Native destructive tools | Disable/template/remove retain canonical holds | No second consumption or model-supplied approval | Owner; existing native executor + continuation | Existing host tests plus plugin client integration |
| Embed | Save and layout returns embed; existing CookbookApp omits dock | Engine selection and other tenant/user retained | Owner; existing host row JSON update | Layout + component/browser evidence |
| Launcher | Reuses verified credential and current origin | Revoked/private-mode/symlink refusal, no remint | Local user; canonical store verify | Subprocess stdio; desktop tests |

## Reuse check

MCP `review_smrt_project` reviewed app-cli, app-runtime, desktop, template, core and
the product; `build_context` queried harness setup, tokens, settings, live tools and
continuations. The configured server exposes context/model inventory but no
separate component/recipe/intent search API. Read the intent index; `rg` searched
smrt-ui, smrt-svelte, chat, core and owning packages by name and purpose:
plugin/setup/connect/settings, credential/config/token/holder, launcher/stdio,
approval/continuation/outcome, embed/dock, list_changed/catalog/exposure.

New files: `host/plugin-mode.ts` composes saveCliConfig, generateLocalMcpSetup,
runLauncher, local token store and existing host persistence; no existing owner
settings composition generated these connections. Product `PluginModeSettings.svelte`
uses ShellSettingsPage's extension slot, shared Card/Button/Toggle/i18n and the
ConnectAi composition pattern; no existing component managed app MCP clients.
Product `/api/plugin-mode/+server.ts` is only a mount. `cookbookPluginMode.test.ts` reuses
runtime owner/session/SQLite, existing host fixture patterns, and SDK Client/
StdioClientTransport; its two noun models are test-only fixtures, not app models.


## Integration rebase

Rebased on `b018dca6a544e572c10a9541b290eff0110fa875`. Keep the integration
CLI continuation capture for thread and non-thread model holds; the plugin
adds its trusted client label and an internal projection marker to that binding.
It does not restore the old direct-authority thread branch. Scope opt-in still
uses original issued metadata; per-turn CLI tokens still use their actual offered
canonical operation intersection. Structured results and synchronous hold
publication remain intact. Onboarding alone can supply `initialSetup`; plugin
template apply retains its normal owner hold.

The three-launcher fixture compares every name, description and schema to the
shared catalog and captures a real in-app fake-model turn, including after the
outcome reader appears. It enables a recipe that was already an active hidden
prerequisite, checks list_changed, publishes a linked custom list through MCP,
and uses the existing screen reference adapter to find/read the named target
through the authenticated REST path. Same-name app replacement, STI creation
and inline contact projection are additionally checked in the real packaged app
and retained host/onboarding fixtures. The explicit Profile STI control now
places that list deliberately; default prerequisites stay hidden.

Codex plugin configuration/SDK transport success is not in-app engine readiness.
Native Codex 0.162.1 remains refused by inference's preflight policy; no code-host
flag, sandbox policy, model or billing fallback is changed. Product Settings
keeps the integration's shared PrebuiltComponentsSettings composition.

Reuse repeated MCP project reviews/context plus intent-index and name/purpose
searches for tool aliases, placements, summaries, native holds and scopes in
UI/Svelte/chat/core and the owning packages. `functionName` extends chat's
existing renderer/dispatch maps. The outcome tool moves the existing reader
behind the existing PrincipalTool seam; no new store or approval executor.
The reference case reuses createRecipeScreenReferences, screenReferenceTarget,
screenRecordLabel and APIGenerator. No new production file was introduced by
this follow-up. Generated lock/knowledge artifacts are regenerated, not merged.

API-profile custom methods additionally reuse core's `resolveApiMethodExposure`
with the effective model config. A permission-catalog method such as Customer's
internal `getProfileId` must not become an app tool when its owning API include
list excludes it. Standard principal-scoped CRUD and CLI's generated MCP policy
remain unchanged. The real Customer assistant regression and packaged catalog
assertion cover this boundary; there is no hand-written method-name blacklist.
