/**
 * One capability classification contract shared by every WebMCP declaration
 * site (#2587). This module intentionally has no runtime code.
 *
 * Core classifies every canonical model tool at build time
 * (`packages/core/src/generators/tool-schema.ts`) and emits the resolved
 * `effect` / `idempotent` / `openWorld` on each `webMcpToolDefinitions` entry.
 * smrt-web's browser registrar trusts that emitted metadata for canonical
 * definitions instead of recomputing it, and keeps its own CRUD switch only
 * as the fail-closed fallback for legacy definitions that carry no metadata.
 * View intents (#2588) classify by this same contract where they are
 * declared; playbook steps (#2589) inherit classification from the model
 * operation they reference and never classify anything themselves.
 *
 * `smrt-web` cannot import this package — its dependency-DAG guardrails keep
 * it free of every `@happyvertical/*` dependency (see its AGENTS.md) — so its
 * `WebMcpToolEffect` mirrors {@link CapabilityEffect} structurally rather than
 * importing it, the same way `data-query.ts` mirrors this package's bounded
 * query envelope there. `smrt-core`'s `ToolEffect` (`src/registry/types.ts`)
 * DOES alias {@link CapabilityEffect} directly, since core already depends on
 * this package.
 */

/**
 * Browser/agent-visible effect classification for a generated capability.
 * `'read'` never mutates; `'write'` mutates within the application;
 * `'destructive'` may remove or irreversibly change data.
 */
export type CapabilityEffect = 'read' | 'write' | 'destructive';

/**
 * Fully resolved capability classification for one declared action.
 *
 * **Fail-closed rule**: an undeclared capability resolves to
 * `{ effect: 'destructive', idempotent: false, openWorld: true }` — the most
 * restrictive exposure a policy can select. Every classifier in the mirror
 * (core's generator, smrt-web's legacy fallback, and any future declaration
 * site) MUST apply this exact default rather than inventing its own.
 *
 * **CRUD is fixed** and never overridden by a declaration:
 * - `list` / `get` → `{ effect: 'read', idempotent: true, openWorld: false }`
 * - `create` → `{ effect: 'write', idempotent: false, openWorld: false }`
 * - `update` → `{ effect: 'write', idempotent: true, openWorld: false }`
 * - `delete` → `{ effect: 'destructive', idempotent: true, openWorld: false }`
 *
 * Anything else (a custom action, a view intent, a playbook step) resolves
 * through an explicit {@link CapabilityDeclaration}, defaulted per-field by
 * the fail-closed rule above.
 */
export interface CapabilityClassification {
  effect: CapabilityEffect;
  /** Whether repeating the action with the same arguments is safe. */
  idempotent: boolean;
  /** Whether the action may interact outside the SMRT application. */
  openWorld: boolean;
}

/**
 * An author-supplied, partial classification. Any field a declaration omits
 * resolves through the fail-closed rule documented on
 * {@link CapabilityClassification}, never through a CRUD- or name-based guess.
 */
export type CapabilityDeclaration = Partial<CapabilityClassification>;
