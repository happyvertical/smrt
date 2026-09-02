/**
 * The one capability classification rule this package applies, extracted so
 * every declaration site in smrt-web shares a single implementation (#2587,
 * #2588).
 *
 * Two sites consume it today: `webmcp.ts` (canonical definitions trusted
 * through it directly, and its legacy CRUD switch's fail-closed default
 * branch) and `intents.ts` (a declared view intent, which is never a CRUD
 * verb and so resolves through the declaration rule alone). Keeping the rule
 * here rather than private to `webmcp.ts` is what lets the intent path be a
 * dependency-free module that never pulls the client-data engine.
 *
 * This module structurally mirrors `CapabilityEffect` / `CapabilityDeclaration`
 * / `CapabilityClassification` in `@happyvertical/smrt-types` rather than
 * importing them — this package's dependency-DAG guardrails keep it free of
 * every `@happyvertical/*` dependency (see AGENTS.md "No inter-smrt
 * dependencies"), the same reason `data-query.ts` mirrors that package's
 * bounded query envelope structurally instead of importing it.
 */

/**
 * Browser/agent-visible effect classification for a capability. `'read'`
 * never mutates; `'write'` mutates within the application; `'destructive'`
 * may remove or irreversibly change data.
 */
export type WebMcpToolEffect = 'read' | 'write' | 'destructive';

/** Every valid {@link WebMcpToolEffect}, in exposure-breadth order. */
export const WEBMCP_TOOL_EFFECTS: readonly WebMcpToolEffect[] = [
  'read',
  'write',
  'destructive',
];

/**
 * An author-supplied, partial classification. Any omitted field resolves
 * through the fail-closed rule on {@link resolveDeclaredCapability}, never
 * through a CRUD- or name-based guess.
 */
export interface WebMcpCapabilityDeclaration {
  effect?: WebMcpToolEffect;
  idempotent?: boolean;
  openWorld?: boolean;
}

/** A fully resolved classification. */
export interface WebMcpCapabilityClassification {
  effect: WebMcpToolEffect;
  /**
   * Derived, never declared: every non-read effect is annotated destructive
   * to the browser, so a `write` capability cannot claim the MCP
   * additive-only guarantee.
   */
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

/** The MCP-shaped annotation set a resolved classification emits. */
export interface WebMcpCapabilityAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  untrustedContentHint: boolean;
}

/**
 * Resolve a declared capability with no CRUD/action-based guess — the shared
 * fail-closed default documented on `CapabilityClassification` in
 * `@happyvertical/smrt-types` (#2587): an omitted or invalid `effect`
 * resolves to `'destructive'`, an omitted `idempotent` to `false`, an
 * omitted `openWorld` to `true`. Each field defaults independently: a
 * declared `effect: 'read'` does NOT imply `idempotent: true`.
 */
export function resolveDeclaredCapability(
  declared: WebMcpCapabilityDeclaration,
): WebMcpCapabilityClassification {
  const effect = WEBMCP_TOOL_EFFECTS.includes(
    declared.effect as WebMcpToolEffect,
  )
    ? (declared.effect as WebMcpToolEffect)
    : 'destructive';
  return {
    effect,
    destructive: effect !== 'read',
    idempotent: declared.idempotent ?? false,
    openWorld: declared.openWorld ?? true,
  };
}

/**
 * The browser annotations a resolved classification is finally registered
 * with. `destructiveHint` carries the DERIVED `destructive` flag, so a
 * `write` capability is annotated destructive exactly like a generated
 * custom model action declared `effect: 'write'`.
 */
export function capabilityAnnotations(
  classification: WebMcpCapabilityClassification,
): WebMcpCapabilityAnnotations {
  return {
    readOnlyHint: classification.effect === 'read',
    destructiveHint: classification.destructive,
    idempotentHint: classification.idempotent,
    openWorldHint: classification.openWorld,
    untrustedContentHint: true,
  };
}

/**
 * Encode a resolved classification as the INPUT hints
 * `registerWebMcpBespokeTool` decodes (`bespokeDeclaredSemantics`), so a
 * capability resolved here survives that registrar's own re-resolution
 * unchanged.
 *
 * This is deliberately NOT {@link capabilityAnnotations}. That function emits
 * the derived `destructive` flag, and `destructiveHint: true` is the first
 * check the registrar makes — round-tripping it would silently upgrade every
 * `write` capability to `destructive`. On the input side `destructiveHint`
 * means "the author declared the destructive EFFECT", and `false` selects the
 * `write` bucket; the registrar re-emits it as `true` on its way to the
 * browser.
 */
export function capabilityDeclarationHints(
  classification: WebMcpCapabilityClassification,
): WebMcpCapabilityAnnotations {
  return {
    readOnlyHint: classification.effect === 'read',
    destructiveHint: classification.effect === 'destructive',
    idempotentHint: classification.idempotent,
    openWorldHint: classification.openWorld,
    untrustedContentHint: true,
  };
}
