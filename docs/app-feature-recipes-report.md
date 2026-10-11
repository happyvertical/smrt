# App-wide feature recipes: what smrt offers any app out of the box

Research report (read only). Source: `/Users/will/Work/_trees/smrt/integration` (branch `integration/planner-batch`, head `271b588b4`), cross-checked against open GitHub issues on `happyvertical/smrt` (200 listed) and the SDK at `~/Work/happyvertical/repos/sdk`. Written 2026-10-09.

## 0. Read this first

### How recipes work today (constraints that shape every suggestion)

- `SmrtRecipe` (`packages/core/src/recipe.ts`, doc `packages/core/agents/recipes.md`) is declaration only: `id`, `label`, `summary`, `synonyms`, `models[]`, `nav[{label, model}]`, `requires[]`, `options` (field-policy hints plus narrowing of API/MCP/CLI exposure), `help` (a Markdown file). The scanner emits them into `manifest.json` / `smrt-knowledge.json` as a top-level `recipes` array.
- Only 4 recipes exist anywhere: `commerce.customers`, `commerce.vendors`, `commerce.sales`, `commerce.purchases` (`packages/commerce/src/recipes.ts`). Every domain-agnostic package is recipe-free.
- A recipe must live in the package that owns the models, must extend `SmrtRecipe` directly, and must list real model classes. Nav entries are model-bound.
- Related open work: #3604 (portable JSON of an assembled app: recipes, options, layout, theme, plus `smrt create --cookbook`), #3593 (aggregate dependency recipes into a consumer's merged manifest), #3596 (rescan and digest recipe help files), #3560/#3562/#3563 (`smrt add` / `remove` / `--extend`).
- `smrt-planner` (`~/Work/happyvertical/repos/smrt-planner`) is currently a README-only repo ("Chat with an in-browser LLM and watch a s-m-r-t app assemble itself"). The Features section does not exist yet.

**Structural gap that matters for this whole report.** Many of the best app-wide features are not "a list of models with a nav entry". They are a shell widget (Assistant dock, Activity ticker, notification bell), a component with a host transport, a server route, or a settings panel. The recipe contract has no way to declare non-model surfaces (components, routes, shell slots), provider or secret requirements, a server-only flag, or demo seed data. Recommended contract extension is in section 4, gap G1.

### Demoability in the planner (static browser app)

The planner needs three things: (a) the package root and its models load in a browser, (b) migrations and CRUD run on `@happyvertical/sql/pglite`, (c) the Svelte surface renders.

- Epic #3622 ("model packages load in the browser") is open. The bundle-gate ratchet (`packages/bundle-gate/src/browser-gate/expected-failures.ts`, reflecting main at `141ed973c`) says 28 of the model packages still fail a browser build. Fix children: #3614, #2838, #3615 to #3618, #3624 to #3628, #3635.
- **Browser-safe model roots today** (not on the failure list): analytics, assets, facts, ingestion, messages, personas, playbooks, prompts, tags, marketing, ads, inventory, manufacturing, human-resources, properties, sites.
- **Still failing** (cause in parentheses): users, tenancy (`node:crypto`, `async_hooks`; #3624, #3626), profiles (#3617), chat and agents (#3624), jobs (#3615, #3627), features and fields (#3618), secrets (#3627), languages (#3624), reports (#3624, #3625), subscriptions and support (#3626), social (#3624), content (#3624, #3627), images (#3628), video and voice (#3627), core itself (#2838, #3635).
- **UI is largely independent of the model-root problem.** `smrt-ui` and `smrt-svelte` are pure Svelte and offer a lot (section 3). Features whose UI is a controlled component fed by props or a transport (Assistant dock, record history, audit list, AdminShell activity) can be demoed with sample data before their model package builds for the browser. The caveat is the `/svelte` subpath of each package, which may import the package root; treat as "likely, verify per package".
- Everything that talks to a third party (IMAP/SMTP, Slack, OAuth providers, S3, Stripe, GA4, remote LLMs) is server-only. In the planner these show as a configured-but-mocked state. The one real in-browser AI path is `smrt-svelte/browser-ai` (LLM, STT, TTS adapters with a capability detector).

Demo legend used below: **Live** = could run in browser with real PGlite CRUD once the root builds; **Sample** = renders with in-memory or fixture data today; **Mock** = UI only, server needed for the real thing; **Server** = cannot be demoed meaningfully.

---

## 1. Catalog by category

Maturity labels: **shipped** (in package, documented, tested), **partial** (works but a known piece is missing), **forthcoming** (issue open, code absent or stub). All packages publish as `@happyvertical/smrt-<name>` (directory names omit the prefix). No `SmrtRecipe` exists for any item below unless stated.

### A. Identity and access

**A1. Sign-in and accounts** (owner-friendly: "your app has real users who can sign in")
- Packages: `users`, `profiles`, `app-runtime`, `app-cli`, SDK `auth`.
- Models: `User`, `Session`, `UsersPasswordCredential` (opt-in per #3568), `UsersPinCredential` (tablet PIN), `UsersMagicLinkToken`, `OidcIdentity` (profiles), `UsersLoginAttempt`, `UsersLoginAuditEvent`, `UsersCliAuthRequest` (device-code CLI sign-in), `NostrIdentity`.
- Key services: `SessionService`, `PasswordCredentialService`, `MagicLinkService`, `OidcLoginService` (Kanidm, Dex, Keycloak style), `MobileAuthService`, `TerminalAuthService`, `LoginAttemptLimiter`; SvelteKit `createSessionHandler`, `createOidcLoginHandler`, `createOidcCallbackHandler`.
- UI: `UserForm`, `UserMenu`, `UserAvatar`, `UserCard`, `UserList`, `InviteUserModal` (users/svelte); `OwnerSetupForm`, `WorkspaceAccountMenu` (smrt-svelte). There is no sign-in form, magic-link form, or passkey component anywhere (searched all `.svelte`). Gap G5.
- Surfaces: generated REST/CLI/MCP for users; `smrt-app-cli` device-code login; mobile auth for KMP apps.
- Maturity: shipped. Forthcoming: passkeys #3275, SDK authorization server tied to users and MCP #3659, session revocation hardening #3509/#3480/#3479, separate account vs address login budgets #3531, tablet sign-out #3577.
- Setup: server-only (cookies, hooks, hashing). An IdP for OIDC; email provider for magic links.
- Demo: Mock. A fake "sign in as persona" switcher is possible but would be a planner fixture, not the real feature.
- Suggested recipes: `users.accounts` (models `User`, `Session`; nav "People"), `users.sign-in-methods` (credential and login-audit models; help file explains password, PIN, magic link, OIDC).
- Blockers: root fails browser gate (#3624, #3626); no login UI.

**A2. Roles, permissions and sharing**
- Packages: `users`, `smrt-ui`, `smrt-svelte`.
- Models: `Role`, `Permission`, `RolePermission`, `Group`, `GroupMember`, `GroupRole`, `Membership`, `MembershipOverride`, `TenantPermissionOverride`, `ResourceGrant` (per-record sharing).
- Services: `PermissionResolver`, `PermissionCatalogService` (`syncPermissionCatalog`), `ResourceGrantService`, `OperationPermissionService`; system roles seeded by `RoleCollection.seedSystemRoles()` (owner, admin, member, viewer).
- UI (smrt-ui): `RoleBadge`, `RoleSelector`, `PermissionPicker`, `PermissionCheck`, `MembershipCard`, `MembershipList`. No per-person override editor yet (#3376).
- Maturity: shipped; hardening open (#3375 MembershipOverride uniqueness, #3025/#3026 grant guard).
- Setup: none beyond a DB; server enforces. Browser-capable once root builds.
- Demo: Sample now (the components), Live after #3624/#3626.
- Suggested recipes: `users.roles-and-permissions` (nav Roles, Groups), `users.sharing` (ResourceGrant).

**A3. Workspaces and teams (multi-tenancy)**
- Packages: `tenancy`, `users` (`Tenant`, `TenantIntegration`), `sites`, `subscriptions`.
- Models: `Tenant` (hierarchical), `BillingRelationship`, `Site`, `SiteAgentBinding`. `@TenantScoped`, `withTenant`, automatic query filtering.
- UI: `TenantSwitcher`, `TenantCard` (smrt-svelte/tenancy ui), `TenantNav`, `WorkspaceAccountMenu`.
- Maturity: shipped; a tenant time zone and typed tenant settings are forthcoming (#3461).
- Demo: Sample (switcher, cards); the real isolation only matters server-side but PGlite could prove it.
- Suggested recipes: `tenancy.workspaces` (nav Workspaces).

**A4. Invitations and access requests**
- `users`: `AccessRequest` + `AccessRequestService` ("request access, owner approves"), `InviteUserModal`. Maturity shipped. Setup: email for delivery. Demo: Mock/Sample. Suggested recipe: `users.access-requests`.

**A5. People and organizations directory**
- Package `profiles`: `Profile` (STI: `Person`, `Organization`, `Bot`), `ProfileRelationship`/types/terms, `ProfileLink`, `ProfileMetadata`/`Metafield`, `ProfileAsset`. Domain-agnostic "contacts" base used by users, events, commerce parties, HR.
- UI: none shipped in profiles (cards come from consumers). Maturity shipped. Root fails browser gate (#3617).
- Suggested recipe: `profiles.directory` (nav People, Organizations).

**A6. API keys and service identities**
- `profiles`: `ApiKey`, `NostrIdentity`, `MagicLinkToken`; `app-runtime` local MCP tokens; `app-cli` device login. Maturity shipped, no UI. Server-only (hashing). Suggested recipe: `profiles.api-keys` (models `ApiKey`; help explains scopes).

**A7. Secrets vault**
- `secrets`: `Secret`, `SecretAuditLog`, `TenantKey`; `SecretService.store/retrieve/list`; three-layer envelope encryption (needs `SMRT_SECRET_MASTER_KEY`). Messages and social store credentials through it. UI none. Server-only (SDK secrets uses `node:child_process`; #3627). Suggested recipe: `secrets.vault` (nav Secrets, names only, values write-only). Demo: Mock.

**A8. Rate limiting for public endpoints**: forthcoming #3306 (shared multi-instance limiter). Credential-only limiter exists (`LoginAttemptLimiter`). Not recipe-shaped; list for completeness.

### B. Communication

**B1. Email client (mailbox)**
- Package `messages`. Models: `EmailAccount` (SMTP/IMAP, credentials via `setCredentials()` into smrt-secrets), `Email` (RFC 822 threading, cc/bcc, html/text), `EmailFolder`, `EmailAttachment`, `Whitelist`/`Blacklist`; `email.send()` / `retrySend()` with `draft > sending > sent | failed`; SDK `email` adapters.
- UI (messages/svelte, ~20 components): `FolderNav`, `MessageList`, `MessageDetail`, `ThreadView`, `ComposeForm`, `ReplyForm`, `ForwardForm`, `RecipientInput`, `AttachmentUpload`, `MessageFilters`, `MessageToolbar`, `EmailAccountManager`, `EmailFilterManager`, `AccountList`, status badges. Playground module exists (`messages/src/playground.ts`).
- Maturity: shipped. Sync from IMAP records `hasAttachments` but does not persist bytes (#3668 notes this; ingestion owns the narrow fix).
- Setup: SMTP/IMAP credentials, server process. Root is browser-safe (not on the failure list).
- Demo: Sample/Live for folders, threads, compose, drafts against PGlite with fixture mail; sending is Mock.
- Suggested recipes: `messages.mailbox` (nav Inbox/Mail: `Email`, `EmailFolder`), `messages.email-accounts` (`EmailAccount`).

**B2. Multi-channel outbound messaging and routing**
- `messages` + `personas`: `MessagingEndpoint`, `PersonaMessageRoute`, senders for email, Slack, Telegram, Zulip, Twitter/X; `MessagingSettingsService`, `PersonaMessagingService`; `createPersonaMessagingTool` lets an agent send through a fixed route. UI `MessagingSettingsPanel`, `AccountCard`. Maturity shipped (ADR 0001). Setup: provider credentials. Demo: Mock. Suggested recipe: `messages.channels`.

**B3. In-app notifications**
- `messages`: `UserNotification` and `UserNotificationService.notify` (idempotent per tenant/recipient/sourceRef), `listForUser`, `countUnread`, `markRead`, `dismiss`, `markAllRead`. Generated REST/MCP/CLI off by design; host routes required.
- UI: shell has `ActivityBadge`, `ActivityToasts`, `ActivityTicker`, `ActivityList` (AdminShell) but nothing wires them to `UserNotification`, and there is no notification bell component. Gap G3.
- Maturity: model and service shipped; UI partial. Demo: Live (browser-safe root) once a bell exists. Suggested recipe: `messages.notifications` (nav Notifications).

**B4. Team chat (internal chat)**
- Package `chat`. Models `ChatRoom` (public, private, DM, agent), `ChatParticipant`, `ChatMessage` (text/system/action/file/tool_call/tool_result), `ChatThread`, `ChatReaction`, `AgentSession`, `VoiceSession`, `VoiceGatewayTurn`.
- UI (chat/svelte): `ChatLayout`, `RoomList`, `RoomHeader`, `RoomCreateDialog`, `MessageList`, `MessageItem`, `MessageInput`, `ThreadPanel`, `MemberList`, `MentionAutocomplete`, `ReactionPicker`, `ReadReceipts`, `UserPresence`, `SearchMessages`, `LinkPreview`, `FileUpload`, `MiniChat`, `ChatTabs`. SvelteKit routes in the package. Playground exists.
- Maturity: shipped; streamed assistant responses forthcoming (#2908). Realtime transport is an app concern.
- Setup: a server for multi-user realtime; single-user demo needs none. Root fails the browser gate (#3624: `node:crypto`, `async_hooks`).
- Demo: Sample now (components with fixtures), Live after #3624.
- Suggested recipes: `chat.rooms` (nav Chat: `ChatRoom`, `ChatMessage`), `chat.direct-messages`.

**B5. Support desk (helpdesk)**
- `support`: `SupportCase` (+ events, interactions, escalation, service targets/SLAs, availability, specialists, policies, AI runs), channel binding from chat and email. UI `CaseQueue`, `CaseDetail`, `TargetList`, `RoutingRationale`. Commercial layer (`SupportPlan`, `SupportCharge`, compensation) is separable. Needs timesheets. Maturity shipped. Root fails gate (#3626). Suggested recipe: `support.cases` (nav Support). Domain-agnostic enough to count.

**B6. Social publishing**
- `social`: `SocialAccount`, `SocialPost` (schedule, publish, analytics snapshots), `OAuthState` (initiator and return target bound; #3553 merged), providers YouTube, Threads, X, Bluesky via SDK. UI `SocialAccountSettings` only. Setup: OAuth apps per platform; server-only. `claimForPublish` atomicity open (#3300). Suggested recipe: `social.publishing`. Demo: Mock.

### C. Intelligence and AI

**C1. AI assistant (in-app)**
- Package `chat` (+ `smrt-ui` data-surface, `agents`, `smrt-svelte` WebMCP). `AssistantDock` (shell-mounted, route-aware; sees the `DataSurfaceDescriptor`s mounted on the page; proposes actions for human review), `createAssistantDockController`, `AssistantThreadList`, `AssistantComposer`, `AssistantChoiceCards`, `ModelPicker`; transports `createInMemoryAssistantTransport`, `createSmrtAssistantTransport`, `createAssistantHttpTransport`; server `runAssistantTurn`, `mountAssistantRoutes` (SvelteKit), tool loop with allow-list, supervised runs. Doc `docs/assistant-dock.md`.
- Forthcoming: floating assistant and photographic cutout character (epic #3641, #3642, #3644, #3663, #3679, #3684), choice tools are always read-only (#3310), supported agent-authored replies (#3223), streaming (#2908).
- Setup: an LLM. Server route with provider key for real use; in the planner the in-memory transport plus `smrt-svelte/browser-ai` LLM adapter is the demo path (the same approach the planner itself is built on).
- Maturity: shipped (phase 1 of epic #2433); presentation upgrades forthcoming.
- Demo: Live/Sample. Best "show off" item. Suggested recipe: `chat.assistant` (models `AgentSession`, `ChatMessage`; nav "Assistant"; help file).

**C2. Agents, schedules and run history**
- `agents`: `Agent` base class with lifecycle, interests, inter-agent messaging, config; `AgentSchedule`, `AgentConfig`, `TenantAgent` (per-tenant enable and capability cap). UI `AgentDashboard`, `AgentAdminPanel`, `AgentAdminTabs`, `AgentScheduleList/Form`, `AgentRunHistory`, `AgentSettingsForm`, `ScheduleStatusBadge`. Open: #3293 (operations read model: did my scheduled work run), #3390 (`AgentSchedule.save()` never sets `nextRun`), #3304 (raw checkbox for boolean settings).
- Setup: jobs worker for scheduled runs; server. Root fails gate (#3624, #3626). Demo: Sample. Suggested recipe: `agents.automation` (nav Agents, Schedules).

**C3. Personas and learning**
- `personas`: `AgentPersona` (tenant-owned, context-scoped instructions, tools, identity, memory scope, priority), `DirectiveProposal`, `Feedback`; gated learning (feedback, reflection, human-approved directive changes). UI `DirectiveReviewQueue`. Maturity shipped; messaging models load lazily (#3535). Root browser-safe. Demo: Live/Sample. Suggested recipe: `personas.assistants` (nav Personas, Review queue).

**C4. Prompt library, playbooks and language strings (editable AI behaviour and wording)**
- `prompts` (`PromptOverride`, `PromptSettingsPanel`), `playbooks` (`PlaybookOverride`, named multi-step plans for agents; plans are non-atomic, each step authorized), `languages` (`LanguageOverride`, `LanguageTranslationTask`; AI auto-translation via jobs; CLI). Prompts and playbooks roots are browser-safe; languages is not (#3624). Demo: Live (prompts, playbooks), Sample (languages). Suggested recipes: `prompts.library`, `playbooks.plans`, `languages.translations`.

**C5. Reports by request (agent-generated reports)**
- `reports` (materialized aggregate reports declared as decorated classes with `@groupBy`, `@sum`, time buckets; refresh manual, scheduled, incremental, TTL; `buildReportAdapterDescriptor` gives deterministic descriptors and a DataTable hint; `queryReportMaterializedRows`, drilldown, facets), `agents` (`createReportDataSurfaceTools`: `reports.query`, `.refresh`, `.drilldown`, `.export`, principal-bound), `analytics` (`AnalyticsReport` with ONCE/DAILY/WEEKLY/MONTHLY `calculateNextRun`/`isDue`).
- UI: `analytics/svelte` (`StatCard`, `TrendBadge`, `AnalyticsSummary`, `EventsTable`, `PropertyInfo`). `reports` has no Svelte surface; the descriptor targets `smrt-ui` `DataTable`.
- Important limitation: report definitions are compile-time decorated classes. There is no runtime path for an agent to define a new report from a user's natural-language request; the agent can only discover, query and refresh declared ones. Gap G4.
- Open: #3063 (scheduled tenant-scoped refresh), #3525 (no `__smrt-register__` shim). Root fails gate (#3624, #3625: needs sync query builders from sql).
- Demo: Sample (descriptor plus DataTable plus fixture rows); Live blocked. Suggested recipes: `reports.materialized` (nav Reports: `SmrtReport`, `SmrtReportRun`, `SmrtReportSchedule`), `analytics.reports` (analytics browser-safe).

**C6. Knowledge base (facts with provenance)**
- `facts`: `Fact` with parent-child evolution, `FactSource`, `FactSubject`, `FactEvidence`, `FactTag`, `FactContent`, semantic dedupe with 3-zone reconciliation and confidence. No Svelte surface. Content's fact-audit uses it. Root browser-safe. Demo: Live data, needs a simple list UI (`smrt-ui` `DataTable` generic). Suggested recipe: `facts.knowledge-base` (nav Facts, Sources).

**C7. Voice and dictation**
- `smrt-ui`: `DictationButton`, `DictationStatus` (hold-to-talk #3576 forthcoming), hands-free forms (`forms/hands-free`), `CameraCapture`; `smrt-svelte`: `VoiceInput`, `FormMicButton`, STT/TTS adapters in `browser-ai`; `chat`: `VoiceSession`, voice gateway; `voice` package (`VoiceProfile`, `VoiceSample`, `VoiceOutput` for synthesis and cloning, server). Browser speech cancel fix #3651. Demo: Live for dictation (browser). Suggested recipes: `smrt-ui` has no model so this belongs in the shell/cookbook layer (gap G1); `voice.profiles` for the model part (fails gate #3627).

**C8. In-browser AI runtime**: `smrt-svelte/browser-ai` (LLM, STT, TTS adapters, `AILoadingOverlay`, `ModelStatusControl`, capability detector, `CapabilityGate`). Not a recipe by itself; it is the planner's own engine and the reason several of the above can be demoed. Mention in the planner's Features intro.

### D. Content and files

**D1. File and media library**
- `assets`: `Asset`, `Folder`, `AssetType`, `AssetStatus`, `AssetMetafield`, `AssetTag`, `AssetAssociation` (generic provenance only; ownership uses noun-specific joins), versioning, SDK `files` storage; `assets-local` (image metadata and variants), `assets-ergot` (processing and search adapter).
- UI: `AssetManager`, `AssetGrid`, `AssetList`, `AssetDetail`, `AssetToolbar`, `ActionBar`, `CreateAssetModal`, `AttachmentPanel`, `AttachmentUpload`, `AttachmentList`, routes `AssetManagerRoute`. Playground exists. Browser resize before upload forthcoming (#3658).
- Maturity: shipped. Root browser-safe. Setup: a storage provider (local FS or S3 style) for real bytes; in the planner, in-memory or OPFS-style demo storage.
- Demo: Live/Sample. Suggested recipes: `assets.library` (nav Files: `Asset`, `Folder`), `assets.attachments` (AttachmentPanel on any record).

**D2. Image studio**: `images` (`Image` extends `Asset`; AI categorization, editing, metadata; `ImageEditor`, `ImageUploader`, `AssetsGallery`, `ImageStudioRoute`). Root Node-only (sharp, resvg; #3628). Demo: Mock. Recipe: `images.gallery`.

**D3. Content and publishing (CMS)**
- `content`: `Article`/`ContentDocument`/`Mirror` (STI), `ContentVersion`, `ContentReview`, `ContentCorrection`, governance policies/profiles/assignments, `ContentContribution` intake with portal and inbox, `ContentContributor`, `ContentFeedSource` (RSS-style sync; #3685 dedupe issue), fact-audit and transparency reports, `ContentReference`.
- UI (≈40 components): `ContentEditor`, `GovernedContentEditor`, `ContentList`, `ArticleList`, `ArticleCard`, `ContentBodyEditor`, `ContentVersionsTool`, `ContentContributionPortal`, `ContentContributionInbox`, `ContentGovernanceManager`, `ContentAgentChat`, `ContentTransparencyReport`, `Markdown`; routes `ContentWorkspaceRoute`, `PublishedArticleRoute`. Starter descriptor #3564.
- Maturity: shipped, the heaviest feature. Root fails gate (documents/spider graph; #3627, #3624). Demo: Sample (editor and list with fixtures). Suggested recipes: `content.articles` (nav Articles), `content.governance`, `content.contributions` (public submissions with review).

**D4. Tags and categories**: `tags` (`Tag` hierarchies, context-scoped slugs, multi-language `TagAlias`); no UI package, though smrt-ui has `TagsInput`, `Chip`, `FilterChips`. Root browser-safe. Cheapest recipe to ship: `tags.taxonomy`. Demo: Live.

**D5. Video and voice production pipeline**: `video` (`Character`, `Scene`, `VideoShot`, `VideoComposition`, ComfyUI workflows). Niche, server GPU; fails gate (#3627). Recipe: `video.studio` low priority.

**D6. Document intake (see E1).** Input widgets in smrt-ui: `FilePicker`, `CameraCapture`, `SignaturePad`, `DrawingPad` (forthcoming #3463), `PinPad` (#3463).

### E. Data and integration

**E1. Ingestion inbox (uncategorized inputs to reviewed actions)**
- Package `ingestion`, ADR 0004, epic #3668 (children #3669 to #3677). Pipeline: receive, preserve, extract (SDK `pdf`, `ocr`, `speech`, `ai`), interpret, propose, human review, execute, learn. Human approval by default; automation opt-in.
- Models (present): `IntakeItem`, `IntakeEvidence`, `IntakeAnalysis`/`Attempt`, `IntakeProposal`, `IntakeReviewDecision`, `IntakeExecution`, `IntakeAction`, `IntakePlan`, `IntakeFeedback`, `IntakeDispatch`, `IntakeDeletion`. Generated REST/CLI/MCP model mutation is intentionally off; `IngestionService` (`/server`) is the boundary.
- UI: `InboxView`, `ReviewView`, `IntakeInbox`, `IntakeReview`, `ActionReview`, `EvidenceViewer` (merged in #3703; transport-neutral, host callbacks).
- Maturity: **partial**. Foundation, review UI merged. Remaining: evaluation and reference-workflow evidence #3677 (command reserved, fails explicitly), source adapters (email, scan folder, camera, audio), learned rules.
- Setup: extraction providers (server-only), `smrt-assets` storage, jobs worker. Root, `/models`, `/dto` are browser-safe by design.
- Demo: Sample/Live for inbox and review with fixture evidence; extraction is Mock.
- Suggested recipes: `ingestion.inbox` (nav Inbox: `IntakeItem`), `ingestion.review` (nav Review: `IntakeProposal`). `requires: ['assets.library']` is natural.

**E2. Background jobs and schedules**
- `jobs`: `SmrtJob`, `SmrtJobEvent`, `SmrtWorker`, `TaskRunner`, `ScheduleRunner` (cron), MCP task backing, liveness-safe execution, safe terminal outcomes; `ForgeDelivery` inbox (webhook projections; domain-leaning). UI `JobDashboard`, `JobList`, `JobDetail`, `JobStats`, `JobStatusBadge`, `JobActions`. Open: #3141 (template worker polls only `default`), #3346, #3308, #3309, #3392, #3078. Server worker required; root fails gate (#3615). Demo: Sample. Recipe: `jobs.monitor` (nav Jobs).

**E3. Your app as an MCP server and a CLI**
- `app-mcp` (`createMcpAppServer`, `mountMcpAppRoute`; stateless Streamable HTTP; class allowlist, tool policy, scopes), `mcp-apps` (browser bridge for portable MCP Apps), `mcp-openai`, `app-cli` (branded `<app> <resource> <command>` CLI plus stdio MCP bridge), generated REST/CLI/MCP from every `@smrt()` model (core), `dev-mcp`. Open: #3397, #3366, #3468 (timesheets collections listed as tools), #3202 (MCP Apps epic). Server-only except the bridge. Recipe-shaped only as a platform toggle (gap G1). Demo: Mock (show the tool list produced from the manifest, which the planner already has).

**E4. Offline and live client data**: `smrt-web` (cached reactive collections, optimistic writes, offline outbox, live invalidation; durable namespaces #3234), `smrt-mobile` (KMP offline write queue, evidence capture), `smrt-android`/`smrt-ios`. Platform capability. Demo: Live in browser (it is a browser runtime).

**E5. Import, export and portability**: `smrt export`/import CLI (bug #3682), portable app JSON (cookbook #3604), `app-runtime` portable export/import for PostgreSQL local profile (#3079), CSV import UI absent (gap G8).

**E6. Analytics tracking**: `analytics` (`AnalyticsProperty` GA4/Plausible/Matomo, `AnalyticsDataStream`, `AnalyticsEvent` server-side with retry, `AnalyticsReport`). UI cards listed in C5. Browser-safe root. Setup: provider keys. Recipe `analytics.tracking`.

### F. Platform and configuration

**F1. App shell and navigation (WASD shell)**: `smrt-svelte`: `AdminShell`, `WorkspaceShell`, `AppShell`, `RoleShell`, `TenantNav`, `NavTree`, `Breadcrumbs`, `PhoneBottomBar`/`PhoneTopBar`, `ShellLayoutEditor` and `ShellNavEditor` (WYSIWYG layout), docks and tools (`ShellDockTool`, `ToolsDock`), `ShortcutsOverlay`, `SystemStatusChips`, `ShellSettingsPanel`/`Page`, `Board` (kanban), `Sortable`. Open: 4-region slotted shell #3656, opt-in edge toggles #3661, kiosk shell #3620, shell-first routes #3061. Shipped, mostly pure UI, Demo: Live (the planner is itself one). Not a recipe; lives in the planner chrome.

**F2. Feature flags**: `features`: `FeatureDefinition`, `FeatureOverride`, `FeatureResolver.isEnabled`, `FeatureSyncService`, `FeatureSettingsPanel`. Doc/API mismatch #3012. Root fails gate (#3618). Demo: Sample (panel). Recipe `features.flags`.

**F3. Editable forms and field policy**: `fields`: `FieldPolicy`, `FieldPolicySuggestion`, `FieldUsageCounter`, `FieldUsageLearningAgent` (learns which fields people use and suggests basic/advanced), `ObjectForm`, `FieldPolicyEditor`, `FieldPolicyGearButton`, `FieldPolicyControlPanel`, `FieldPolicySuggestionQueue`, `FormHelp`, `AdvancedFields`, `ModeSwitch`. This is what recipes' `options.fields` compile into. Shipped, root fails gate (#3618). Demo: Sample; very strong "customize your own forms" story. Recipe `fields.form-customization`.

**F4. Typed settings**: partial. `smrt-config` file loader; `SettingsCatalog`, `ShellSettingsPage`; typed tenant settings with editor and tenant time zone forthcoming (#3461). Recipe not possible yet.

**F5. Theming and localization**: `smrt-ui` themes and tokens (`ThemeProvider`, theme chooser #3571), i18n client (`useI18n`, `Trans`) with per-package string catalogs, `languages` overrides, country/currency/phone/address inputs. Shipped. Demo: Live.

**F6. Subscriptions, plans and usage**: `subscriptions`: `SubscriptionPlan`, `TenantSubscription`, `TenantUsageMetric`, `SpendingPolicy`, `CreditGrant`, `PriceBook`/`PricingRule` (reseller aware), entitlement resolution and thresholds. UI `PlanPicker`, `SubscriptionSummary`, `UsageThresholds`, `CommercialOverview`. Billing provider optional (neutral). Many open correctness issues (#3093, #3094, #3096, #3103, #3107). Root fails gate (#3626). Recipe `subscriptions.plans` (SaaS apps).

**F7. Runtime profiles and setup**: `app-runtime` (local private app with loopback bootstrap token, self-hosted, cloud), owner setup, diagnostics (`RuntimeDiagnostics`, `SystemStatusChips`). Server. Browser-safe root but local profile is Node. Open: #3037, #3032, #3379, #3079. Not recipe-shaped.

**F8. Work queue**: forthcoming #3667 (`smrt-work`: `WorkItem`, claim and release, queue, events). Not built. Strong generic "tasks/requests" feature once it lands.

### G. Operations and observability

**G-a. Audit trail and record history (the "activity log")**
- `profiles` `AuditLog` (actor, action, reason, before/after `changes`, source, delegated identity), `createAuditWriter`, `readAuditTrail`, `pruneAuditTrail`; core `@smrt({ audit: true })` records automatic collection CRUD (`create/update/delete` accept `actorId`, `reason`); `withAuditContext` for generated SvelteKit routes. Issue #3460 closed. Also `UsersLoginAuditEvent`, `SecretAuditLog`, `ContentVersion`.
- UI (smrt-svelte): `RecordHistory` (per-record timeline, before/after), `AuditList` (authorized entries only; never fetches); shell `ActivityList`, `ActivityItem`, `ActivityTicker`, `ActivityToasts`, `ActivityBadge`.
- Maturity: shipped. Setup: `audit_logs` table via migrations; trusted actor from server. Profiles root fails gate (#3617).
- Demo: Sample now (components fed with entries), Live after #3617/#3626.
- Gap: there is no single "Activity" feature that turns AuditLog into the shell's activity feed (G3). Suggested recipes: `profiles.audit-log` (nav Activity log: `AuditLog`), with `options.exposure` narrowing so no generic CRUD (the model already has no generated read routes).

**G-b. System health**: `smrt-dev-mcp` (job-health, schedule-health, dispatch-health; dev-plane), `RuntimeDiagnosticsWebMcp`, `SystemStatusChips`. Developer-facing; mention only.

---

## 2. Counts by category

| Category | Candidates | Shipped | Partial | Forthcoming |
| --- | --- | --- | --- | --- |
| A. Identity and access | 8 (A1 to A8) | 6 | 1 (A1 UI) | 1 (A8 rate limit) |
| B. Communication | 6 | 5 | 1 (B3 notifications UI) | 0 |
| C. Intelligence and AI | 8 | 5 | 2 (C1 floating UI, C5 ad-hoc reports) | 1 (C8 n/a) |
| D. Content and files | 6 | 4 | 1 (D6) | 0 |
| E. Data and integration | 6 | 4 | 1 (E1 ingestion) | 1 (E5 CSV import) |
| F. Platform and configuration | 8 | 5 | 1 (F4) | 2 (F4 typed settings, F8 work queue) |
| G. Operations and observability | 2 | 1 | 1 (activity feed binding) | 0 |
| **Total** | **44** | | | |

Counts are approximate groupings of the numbered entries above; a few entries (C8, D6, F1, F5, F7, G-b) are platform capabilities rather than recipes.

## 3. UI inventory that is reusable regardless of model package

`smrt-ui` (pure, domain-agnostic): DataTable, Pagination, CollectionList, CollectionToolbar, FilterChips, SortableHeader, Form components (Input, Select, Combobox, DatePicker, TimePicker, MultiSelect, TagsInput, FilePicker, CameraCapture, SignaturePad, AddressInput via smrt-svelte, Currency/Country/Province selects, RelationInput), Calendar/CalendarView/DayView, Tabs, Modal, Drawer, Accordion, Tree, Meter/Progress, Toast, EmptyState, StatusBadge, Avatar, MessageBubble, TypingIndicator, ReactionPicker, StagedControlReview, WorkingStrip, ConfidenceBadge. Themes plus i18n.
`smrt-svelte`: shells, forms (rich `Form` with WebMCP tools), `Board`, `Sortable`, audit components, settings catalog, mcp-apps bridge, browser-ai, `web` bindings for `smrt-web`.
These make "Sample" demos cheap for almost every feature.

## 4. Ranked shortlist: build first

Scoring: showoff impact x readiness x in-browser demoability.

1. **AI assistant** (`chat.assistant`, C1). Most impressive; transport plus browser LLM runs entirely in-browser; shipped; the floating presentation (epic #3641) is the natural upgrade. Verify `chat/svelte` import graph does not drag `node:crypto` (gate #3624).
2. **Files and media library** (`assets.library` plus `assets.attachments`, D1). Browser-safe root, 15 shipped components, playground module, PGlite CRUD plausible today.
3. **Email client** (`messages.mailbox`, B1). Browser-safe root, richest shipped UI after content, instantly recognizable; sending is mocked, fixture mail is live.
4. **Ingestion inbox** (`ingestion.inbox` and `ingestion.review`, E1). The "forthcoming system" headline; root browser-safe by design; review UI just merged (#3703). Label as preview until #3677.
5. **Activity log and record history** (`profiles.audit-log`, G-a). Universal; pure components; shows `@smrt({ audit: true })`. Needs #3617 for Live; Sample works now.
6. **Notifications** (`messages.notifications`, B3). Tiny browser-safe model plus service; needs a bell component to be showable (G3).
7. **Team chat** (`chat.rooms`, B4). Excellent UI inventory; Live blocked by #3624, Sample works.
8. **Form customization** (`fields.form-customization`, F3). Distinctive to smrt and ties directly to how recipes compile `options`. Blocked on #3618 for Live; Sample works.
9. **Reports** (`reports.materialized` plus `analytics.reports`, C5). The maintainer asked for agent-generated reports; start with declared reports queried by the assistant (works via `createReportDataSurfaceTools`), file G4 for runtime definitions. `analytics` is browser-safe now.
10. **Roles, permissions and sharing** (`users.roles-and-permissions`, A2). Core value of smrt; components exist; Live needs #3624/#3626.

Runners-up: tags (`tags.taxonomy`, trivial and browser-safe, good as the very first recipe to prove the pipeline), personas/prompts/playbooks (browser-safe, ideal for the planner's own "assistant behaviour" story), jobs monitor, content articles, support desk, knowledge base.

Suggested first step: ship `tags.taxonomy` and `assets.library` as pipeline proofs (browser-safe, no blockers), then 1, 3, 4.

## 5. Gaps worth filing (burden of proof: why they cannot ship in a current branch)

- **G1. Recipes cannot declare non-model surfaces.** No fields for shell widgets, components, routes, server-only flag, required providers/secrets, demo seed, or the playground entry. Needs a contract change in `smrt-types`/core (a published contract), so it needs its own design issue. Closely related to #3604.
- **G2. No browser-demo metadata per recipe/package** (browser-safe root, needs-server, mock provider). Could be derived from the bundle-gate result; belongs with G1.
- **G3. No "Activity" or "Notifications" turnkey feature.** Shell has `ActivityList/Toasts/Ticker/Badge` and `UserNotification`/`AuditLog` exist, but nothing binds them, and there is no notification bell component. Build in `smrt-svelte` + `smrt-messages` (new component plus a provider/adapter); contract is new public API.
- **G4. Reports cannot be defined at runtime from a user request.** Decorated classes are build-time; agent tools only query/refresh declared reports. Needs a design decision (a declarative report spec stored as data, compiled by the same `@happyvertical/smrt-reports` compiler, with permission and field-policy checks).
- **G5. No sign-in UI components** (password, magic-link, OIDC buttons, passkey #3275). Every consumer rebuilds it.
- **G6. Global search / command palette** is absent (only `SearchInput`; `assets-ergot` search adapter). Cross-model search is a recurring need.
- **G7. Comments and mentions on any record** are absent (chat mentions only). Likely a small polymorphic model plus component.
- **G8. CSV/spreadsheet import-export UI** is absent (`smrt export` CLI has a bug, #3682).
- **G9. Generic approvals/workflow.** Playbooks are non-atomic; ingestion has its own review loop; content has governance. No shared approval primitive (a shared one may be what `smrt-work` #3667 grows into).
- **G10. Outbound webhooks and generic integrations** are absent (only forge projection inbox in jobs).
- **G11. Cross-package consumer UI for the data-only packages** (`tags`, `facts`, `secrets`, `profiles`, `reports`, `prompts` list screens). A generic DataTable-based list screen per recipe would cover them; this may be derivable from recipe nav.
- **G12. Two doc/contract mismatches to repair while here**: `features` README/AGENTS describe a manifest API the package does not have (#3012); `JobStats.svelte.d.ts` shadows the data type (#3392).

## 6. Verification notes and caveats

- Model lists come from each package's `dist/manifest.json`; UI lists come from `*.svelte` files under each package `src`; both reflect the integration worktree, not a published release.
- Browser-gate status is from the ratchet file as of main `141ed973c`; integration may be ahead. Re-run the gate before promising a Live demo.
- I did not run any package, build, or demo. "Demoable" statements are inferences from the dependency and gate data.
- Domain packages were excluded except where noted. Domain-leaning but listed because they contain a generic capability: support (B5), social (B6), subscriptions (F6), jobs `ForgeDelivery` (E2). Marketing, ads, sales, commerce, events, places, products, inventory, ledgers, expenses, timesheets, human-resources, manufacturing, properties, projects, affiliates were not catalogued.
- `gnode` is stubs only (README says so); excluded. `sites` (A3) is a multi-tenant network concept, include only if the planner wants a multi-site story.
