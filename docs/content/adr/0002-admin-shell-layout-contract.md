# AdminShell owns a separate layout contract

AdminShell is the standardized outer chrome for SMRT admin apps, but it is not a thin wrapper around the existing WorkspaceShell/RoleShell layout. We will give it a separate four-edge layout contract so it can own top, left, right, and bottom panel geometry, keyboard behavior, corners, responsive presentation, and activity homes without contorting the older workspace primitives. Existing primitives remain supported and may be reused where they fit, but they do not constrain the AdminShell implementation.

This supersedes the older documentation assumption that AdminShell would be an opinionated wrapper over the first-generation workspace primitives. The trade-off is some duplicated layout responsibility in exchange for a cleaner shell contract and lower migration risk for existing WorkspaceShell consumers.

AdminShell's public core should still be safe to import and render during SSR, but browser-specific behavior is allowed to activate after mount. Hotkey listeners, localStorage persistence, focus trapping, resize observation, and toast animation must not be required for the static server-rendered shell to exist.

The first-generation workspace components (`WorkspaceShell`, `RoleShell`, `NavTree`, `Breadcrumbs`, `ToolsDock`, and their registry helpers) are migration sources, not design constraints. The new AdminShell family may replace their patterns with improved navigation, breadcrumb, dock, and registration APIs rather than preserving old component seams for compatibility. A breaking public API change is acceptable when it produces a cleaner shell contract.

The canonical public import surface is `@happyvertical/smrt-svelte/workspace`. That subpath should expose the new AdminShell family by default; legacy workspace components should not remain first-class exports from the same surface merely for compatibility.

Panel state keeps the `hidden | collapsed | expanded` vocabulary, but `hidden` means the app has omitted an edge. User settings should normally persist only collapsed/expanded preferences for configured edges. Activities assigned to a hidden edge should re-home to System.

Expanded panels should be able to operate independently by default. Mutual exclusion is an app-configurable coordination policy rather than a hardcoded shell rule.

The coordination policy is expressed with explicit exclusivity groups: expanding an edge closes other expanded edges in the same group, while ungrouped edges remain independent.

Push versus overlay presentation is an app decision per edge. It is not a user preference in this release.

User shell settings persist as sparse deltas over framework and app defaults. Deltas should capture user-owned preferences such as panel collapsed/expanded state and hotkey overrides, not app-owned configuration such as hidden edges, presentation mode, or exclusivity groups.

Default shell hotkeys and remaps are stored as `KeyboardEvent.code` values so the WASD cluster remains a physical spatial mnemonic across keyboard layouts.

This release supports unmodified physical keys for panel toggles. The binding type should remain extensible enough to add modifier chords later without changing the storage model wholesale.

Deep-linking is layered on top of the core state model. AdminShell should expose serializable state and commands, but URL parsing, history updates, and SvelteKit route integration belong in adapters or recipes.

Focus dock tools can be registered through both a low-level imperative shell API and a declarative Svelte-facing helper. Declarative mount/unmount registration is the preferred app-facing pattern; the imperative API exists for tests, adapters, and non-component integrations.

Focus tools require a stable `id` within a shell instance and may include optional subject metadata for route or record specificity. Deep links should address tools by tool identity rather than component names or display labels.

Shell activities are client-side records with lifecycle, scope ownership, filtering, badges, and home-edge behavior. Server jobs, polling endpoints, WebSockets, and future `smrt-web` SSE/live-update subscribers can all feed the registry through adapters, but AdminShell should not depend on a concrete transport or on `smrt-jobs`.

System-scope jobs, schedules, dispatch, and connection panels are operational data panels backed by app-provided stores or endpoints. They are separate from shell activities, though app adapters may mirror selected operational items into the activity registry.

Activity toasts are optional renderers/subscribers over the activity registry. The registry should expose lifecycle events or watches; mounted toast components decide which events notify and how fly-home animation is rendered.

Responsive small-screen presentation is part of AdminShell core. The same state model should drive desktop edge panels and mobile sheets/drawers so apps do not build separate mobile shell contracts.

The release adoption proof should include both the smrt-svelte playground and `template-sveltekit`. Playground fixtures prove the component family; the template proves the canonical starting point for new SMRT apps.

Because the workspace surface may break compatibility, the release should include a focused migration guide from the first-generation workspace family to AdminShell concepts.
