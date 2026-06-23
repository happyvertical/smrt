/**
 * @happyvertical/smrt-svelte
 *
 * Top-of-stack Svelte 5 integration layer for SMRT: the app `Provider`, auth /
 * AI hooks, browser-AI adapters, server-side i18n, and the domain-aware
 * composite components (module, workspace, forms).
 *
 * Domain-agnostic UI primitives, the i18n client, the theme system, and the
 * module UI registry now live in `@happyvertical/smrt-ui` — import those from
 * there (e.g. `@happyvertical/smrt-ui/ui`, `@happyvertical/smrt-ui/i18n`). The
 * agent-admin shells (AgentAdminPanel / AgentAdminTabs / AgentSettingsShell)
 * moved to `@happyvertical/smrt-agents/svelte`.
 */

// Form components
export * from './components/forms/index.js';
// Module components (for dynamic module UI rendering)
export * from './components/module/index.js';
// Hooks
export * from './hooks/index.js';
// Core - App wrapper/provider
export { default as Provider } from './Provider.svelte';
// State management
export * from './state/index.js';
