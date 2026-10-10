# Chat recipes (#3719)

Recipes are declared in `src/recipes.ts` (see
[`packages/core/agents/recipes.md`](../../core/agents/recipes.md)) and are
read statically by the scanner. Each class stays self-contained: rooms and the
assistant are separate recipes that add their own class to the same file.

## `chat.assistant` (`AssistantRecipe`)

The AI assistant dock as a shell widget. Help: `src/assistant.recipe.md`.

- **Surface.** One `shell-widget` in `header.end` exporting
  `@happyvertical/smrt-chat/svelte#AssistantDock`. `header.end` is where
  `AppShell` puts `dockToggles` by default; the toggle and the
  `ShellDockTool` come from the host shell, not from this package. The host
  supplies the dock's `transport` and the shell's `DataSurfaceRegistry`
  ([`docs/assistant-dock.md`](../../../docs/assistant-dock.md)).
- **Models.** `AgentSession`, `ChatRoom`, `ChatParticipant`, `ChatThread`,
  `ChatMessage`: the records the assistant routes persist into. No `nav`: the
  generated list routes are tenant-scoped, not member-scoped, so the dock never
  reads them and no admin screen should.
- **Provider.** One `llm` provider. Hosted options (`openai`, `anthropic`,
  `gemini`) each need their own key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, the names `@happyvertical/smrt-config` resolves); the
  browser options (`webllm`, `bitgpu`) need none. Names only, never values.
- **Runtime.** `both`: the dock, the in-memory transport and the browser
  inference path run in the browser; saved conversations and tool turns go
  through `mountAssistantRoutes()` on the server.
- **No `demoSeed`.** The package ships no assistant fixture; the in-memory
  transport starts empty. Add one with `demoSeed` once a fixture exists.
- **Report tools (#3711).** The help describes `createRuntimeReportTools()` as
  an opt-in capability a host passes through `extraTools`. The recipe does not
  wire them.

Tests: `src/__tests__/recipes.test.ts` scans `src` with the real scanner
(declaration validity, qualified model names, emitted surfaces, providers and
runtime), runs `ManifestGenerator.assertRecipeOptions`/`assertRecipeHelp`, and
renders the help.
