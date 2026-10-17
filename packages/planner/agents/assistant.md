# smrt-planner: Assistant, inference, kitchen and AI

Part of the [planner guidance](../AGENTS.md). Paths are relative to `packages/planner/`.

- `src/lib/assistant/`: the in-browser assistant (#3). `session.svelte.ts` is
  the lifecycle (nothing downloads until the visitor accepts the model's size;
  progress, cancel, unload), `engine.ts` loads a WebLLM model in a Web Worker
  (`llm.worker.ts`), `transport.ts` is an `AssistantTransport` over
  `@happyvertical/ai/local`'s `WebLLMProvider`, `change.ts` the per-turn
  `{ reply, add, remove }` schema (enums of RECIPE ids), parse and
  `applyChange` through `recipeState`, `prompt.ts` the recipe vocabulary,
  `models.ts` the offered models, `prefs.ts` the localStorage preference
  (model choice and consent; not part of the cookbook). It navigates only to a menu section the
  running app can open (`menu`: the snapshot's visible sections while `plannerRuntime.openSection`
  is set, through `focus`; the schema then has `open`). What the chat says is the commands'
  results (`honestReply`): the model's sentence stands only when nothing ran, followed by
  "Nothing in the app changed." unless it asks a question; an added recipe with no menu entry says so.
  A request for a report or a summary (the keyword match finds `reports.runtime`) is pointed at
  Reports: an `open` of any other section is dropped.
- Runtime reports (smrt#4100), driven by code so a 1-2B model can do it: the schema's optional
  `report` is an INTENT (`src/lib/reports/intent.ts`: source enum of the app's report sources,
  measures, groupBy, bucket, period, dateField, filters), never a spec. The transport runs the
  steps smrt-chat names (`reports.runtime.sources` -> `define` preview -> `run`) through
  `PlannerReports` (`src/lib/reports/store.ts`): `specFromIntent` resolves loose names, fills
  defaults ("a summary" = count + the document total), reads time with smrt-reports'
  `parseRuntimeReportTime` / `resolveRuntimeReportTimeRange` over the person's words and the intent's
  `bucket`/`range` ("by month", "last quarter by week", "Q3"; relative to the sample clock `EPOCH`),
  buckets the descriptor's `defaultTimeField` (an invoice's issue date), validates with smrt-reports' `parseRuntimeReportSpec`, runs
  `runRuntimeReportInMemory` over the sample rows and returns smrt-reports' `awaiting_confirmation`
  proposal as the message's `toolCallData` (`{ name: 'reports.runtime.define', result }`). Only then
  is `reports.runtime` added (a command, so the reply says so). A report turn ignores the model's
  `add`/`remove`/`open`. An unresolvable intent, or a report request with no intent, is a
  follow-up (`ReportFollowUp`) built from the source descriptor's human groupings, time fields and
  amounts (never ids, hashes or plumbing; the date by month first when time came up), sent as
  smrt-chat's structured question, so the dock shows a form. It is the transport's `pending`
  report: a typed answer resolves against its options in code (`matchAssistantQuestionText`, no
  model turn), the form's submit is `answerQuestion` (no model turn; the question is marked
  answered), a model answer merges into the pending intent, and a turn that answers nothing takes
  the default and says "I went with …": the identical question is never asked twice. `BrowserAssistant` renders the proposal with smrt-reports'
  `ReportConfirmation` (`ReportProposalCard`); Approve (a trusted click) is the browser's confirmed
  save: `save` re-parses, checks the Web Crypto hash, reruns against the current sources and stores a
  RuntimeReport row in the sample data, then `plannerRuntime.openPath` opens it. Sources
  (`sources.ts`) are the menu models of the recipes that are on (`packages.reports.runtime.sources`
  in a generated app). Without a data source (`createPlannerAssistant` for a host's controller) the
  capability is off and a report request says `REPORTS_UNAVAILABLE`. Not an authority boundary:
  sample data has no principal or tenant.
- `src/lib/inference/` (#23, #30): where the model runs. `config.ts` is `planner.config.json`
  (`inference: { mode: manual|browser|host|byo, alternatives?, credentialPersistence?, host?, byo? }`;
  an absent config keeps the standalone browser default, while an invalid present config fails visibly
  to manual; a mounted `Planner`'s `inference` prop overrides it), `host.ts` the host
  `ChatModel` (POSTs `{ version, message, snapshot, history? }`; the server owns the prompt),
  `openai.ts` the browser fetch client for OpenAI-compatible endpoints plus Test connection,
  `presets.ts` Ollama/OpenRouter/OpenAI/custom with CORS notes, `byo.svelte.ts` the AI page state
  (memory-only hosted keys; compatible local persistence stays separate at
  `smrt-planner:inference-key:v1`; every key is origin-bound and sent only as Authorization over
  https or loopback). The wire
  contract and config are specified in `docs/inference-host.md`; change them together with that file.
  `AiState.configure` applies a policy (the layout fetches it) and changes modes only through
  `selectInference`; Think's `where` reads Off / In browser / Server / Your model: <name>.
- `src/lib/kitchen/`: Send to kitchen (smrt#3750). `client.ts` is the `kitchen` block of
  `planner.config.json` (`{ endpoint }` only, parsed by `inference/config.ts` into
  `ConfigResult.kitchen`; a `token` there is ignored) and `sendToKitchen` (POST the cookbook,
  `x-kitchen-token` header, outcome never throws). The one-time token is NEVER in the config:
  `smrt kitchen` opens `http://127.0.0.1:<port>/#kitchen=<token>`, `fragment.ts` reads it from
  `location.hash`, the layout strips the `kitchen` parameter with a replacing `goto` (not bare `replaceState`: that
  leaves the token in `page.url` and the history state's `pageurl`) before the first URL rewrite and
  hands the token to `kitchenState` (memory only, never storage or a URL); a `token` still in the
  config (an older CLI) is never read, only reported (`tokenInConfig`) and Send stays off. `state.svelte.ts`
  is `kitchenState` (`config` needs endpoint and token; `needsLink` is endpoint without token), which
  `ExportPanel` reads to add **Send to kitchen** to its primary actions (after Copy prompt, before
  Download), or to show the missing-link notice. Contract: `docs/inference-host.md`; the server side is smrt `packages/cli/agents/kitchen.md`.
- Package name is `@happyvertical/smrt-planner`. It is released only by the monorepo's batched
  release, at the shared smrt version (root `CHANGESETS.md`); never publish it on its own or from a
  workstation.
- `src/lib/ai/`: THINK (the language model), HEAR (voice typing) and SPEAK
  (read replies aloud with `speechSynthesis`) as one store. `state.svelte.ts`
  (`AiState`, singleton in `instance.ts`) owns the `AssistantSession`, the
  `VoiceSession` and the read-aloud / "I don't need AI" prefs (`smrt-planner:ai:v1`);
  `status.ts` is the pure derivation (`ready` / `available` / `off`, accessible names,
  `needsFirstRunSetup`); `icons.ts` the three icon paths. The sidebar icons
  (`AiStatusIcons`, a `slotItems` entry `ai-status` in `leftSidebar.footer`), the
  `/ai/` page (`AiModelsPage.svelte`, which a mounted `Planner` serves at `#/ai/`) and the
  assistant dock all render `AiSetup.svelte` / read `aiState`. The assistant's header control is
  the shell's own `dock:assistant` item (`plannerAssistantToggle(appHref('/ai/'),
  aiState.assistantReady)`, `planner/shell.ts`; the app's layout and `Planner` both pass it): it
  toggles the `assistant` dock once `aiState.assistantReady` (think `ready`: a loaded browser model,
  the host's server, a connected BYO endpoint); until then the shell renders it as a link to the AI
  setup page ("Set up the assistant"). There is no planner-side toggle; `BrowserAssistant`'s
  not-ready panel only covers a dock left open when the model goes away. A mounted `Planner` configures `aiState` from its `inference` prop
  (`PlannerLifecycle`: `configure(configFromProp(...))`, or `useChat` for `{ chat }`) and only
  then renders the dock and the icon; without the prop it has no assistant.
  First visit: `aiState.hydrate` decides once (nothing downloaded, no read-aloud,
  nothing built, not dismissed) and the Planner page then shows the setup form
  before the tabs; Continue is per visit, "I don't need AI" is remembered.
