/**
 * The page's own view of its WebMCP tools (#2908).
 *
 * Every browser tool source — generated model tools, the fixed `smrt_ui_*`
 * UI tools, declared view intents, and bespoke `useWebMcpTool` tools — ends
 * at one call: `document.modelContext.registerTool(tool, { signal })`. The
 * browser's registry is write-only from the page's side (an outside agent
 * reads it, page script cannot), so an IN-PAGE assistant has no way to offer
 * the model the same tools an outside agent sees.
 *
 * {@link installWebMcpPageToolRegistry} closes that gap without touching any
 * registrar: it puts a recording `modelContext` on the document. Each
 * `registerTool` is kept in a page registry (and forwarded to the browser's
 * native `modelContext` when there is one, so outside agents are unaffected);
 * aborting the registration's signal removes it from both. The page registry
 * then lists the live tools and runs one by name — the SAME `execute` the
 * browser would call, so every registrar's effect gate, consent gate, and
 * REST authorization stay exactly where they are.
 *
 * On a browser without WebMCP the recording context is the only one, which
 * also makes the page's tools available to the in-page assistant everywhere.
 *
 * Install it before the first registration (early in the app's root layout,
 * before the SMRT Provider mounts): a tool registered earlier went straight to
 * the native context and is invisible here. Installing replaces the
 * document's `modelContext`, which also resets the tool-name lock's table
 * (#2613) — harmless at startup, when it is empty.
 *
 * Dependency-free (only the tool-name lock, itself dependency-free); ships as
 * `@happyvertical/smrt-web/webmcp-page-tools`.
 */

import {
  isWebMcpProposalTool,
  type WebMcpToolNameOwner,
  webMcpToolNameOwner,
} from './webmcp-tool-names.js';

/** A tool's effect: read runs, write acts, destructive cannot be undone. */
export type WebMcpPageToolEffect = 'read' | 'write' | 'destructive';

/**
 * The key a SMRT registrar stamps its RESOLVED effect under on the object it
 * hands `registerTool`. The WebMCP annotations it sends the browser are
 * deliberately coarser — every non-read tool is annotated
 * `destructiveHint: true` for outside agents — so the page registry reads
 * the resolved effect here and only falls back to the annotations for a
 * registration that carries none. A browser ignores the extra symbol key.
 */
export const WEBMCP_TOOL_EFFECT: unique symbol = Symbol.for(
  '@happyvertical/smrt-web:webmcp-tool-effect',
) as never;

/** The WebMCP annotation hints a registration may carry. */
export interface WebMcpPageToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  untrustedContentHint?: boolean;
}

/** One live page tool, as the in-page assistant sees it. */
export interface WebMcpPageToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: WebMcpPageToolAnnotations;
  /**
   * The registrar's resolved effect ({@link WEBMCP_TOOL_EFFECT}) when it
   * stamped one. Otherwise from the annotations: `read` for
   * `readOnlyHint: true`, `write` for `destructiveHint: false`, and
   * `destructive` for `destructiveHint: true` or an undeclared effect —
   * smrt-web's own fail-closed classification of a bespoke tool.
   */
  effect: WebMcpPageToolEffect;
  /**
   * Which registration path owns the name (the tool-name lock's label), when
   * known. DIAGNOSTIC ONLY: a bespoke caller can set this label, so it must
   * never decide whether a write runs — read {@link proposal} for that.
   */
  owner?: WebMcpToolNameOwner;
  /**
   * True only when the registered `execute` carries the module-private
   * proposal brand (`markWebMcpProposalTool`): a compiled view intent or a
   * fixed `smrt_ui_*` tool, which can only stage or dispatch through a
   * consent-gated registry as `source: 'agent'`. Such a "write" is a proposal
   * by construction; every other write acts.
   */
  proposal: boolean;
}

/** A registration as the registrars hand it to `registerTool`. */
interface PageToolRegistration {
  [WEBMCP_TOOL_EFFECT]?: WebMcpPageToolEffect;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpPageToolAnnotations;
  execute: (
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => string | Promise<string>;
}

/** What changed, for {@link WebMcpPageToolRegistry.subscribe}. */
export interface WebMcpPageToolEvent {
  type: 'registered' | 'unregistered';
  name: string;
}

/** The page registry an in-page assistant reads and runs tools through. */
export interface WebMcpPageToolRegistry {
  /** The live tools, in registration order. */
  list(): WebMcpPageToolDescriptor[];
  get(name: string): WebMcpPageToolDescriptor | undefined;
  /**
   * Run a live tool by name through its own registered `execute`.
   * Rejects with {@link WebMcpPageToolNotFoundError} for an unknown name.
   * The caller decides WHETHER to run it (effect and confirmation policy);
   * this only runs it.
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  subscribe(listener: (event: WebMcpPageToolEvent) => void): () => void;
  /** Restore the document's previous `modelContext` and forget every tool. */
  uninstall(): void;
}

/** Thrown by {@link WebMcpPageToolRegistry.execute} for a tool that is not live. */
export class WebMcpPageToolNotFoundError extends Error {
  constructor(readonly toolName: string) {
    super(`No page tool named "${toolName}" is registered.`);
    this.name = 'WebMcpPageToolNotFoundError';
  }
}

export interface InstallWebMcpPageToolRegistryOptions {
  /** The document to install on. Defaults to `globalThis.document`. */
  document?: object;
}

const REGISTRY_KEY = Symbol.for(
  '@happyvertical/smrt-web:webmcp-page-tool-registry',
);

interface ModelContextLike {
  registerTool: (
    tool: PageToolRegistration,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
}

function resolveDocument(documentLike: unknown): object | undefined {
  const doc = documentLike ?? (globalThis as { document?: unknown }).document;
  return doc && typeof doc === 'object' ? (doc as object) : undefined;
}

/** Fail-closed effect from WebMCP annotation hints. */
export function webMcpPageToolEffect(
  annotations: WebMcpPageToolAnnotations | undefined,
): WebMcpPageToolEffect {
  // The same rule smrt-web's own registrar applies to a bespoke tool: an
  // effect is `write` only when the tool says it is not destructive, and an
  // undeclared effect is destructive, like an undeclared custom action.
  if (annotations?.destructiveHint === true) return 'destructive';
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === false) return 'write';
  return 'destructive';
}

function stampedEffect(
  tool: PageToolRegistration,
): WebMcpPageToolEffect | undefined {
  const value = tool[WEBMCP_TOOL_EFFECT];
  return value === 'read' || value === 'write' || value === 'destructive'
    ? value
    : undefined;
}

/** The page registry already installed on `document`, if any. */
export function getWebMcpPageToolRegistry(
  options: InstallWebMcpPageToolRegistryOptions = {},
): WebMcpPageToolRegistry | undefined {
  const doc = resolveDocument(options.document);
  if (!doc) return undefined;
  return (doc as Record<symbol, WebMcpPageToolRegistry | undefined>)[
    REGISTRY_KEY
  ];
}

/**
 * Install (or return the already-installed) page tool registry on the
 * document. Returns `undefined` off-DOM (SSR), where there is nothing to
 * record. Idempotent: a second call returns the same registry.
 */
export function installWebMcpPageToolRegistry(
  options: InstallWebMcpPageToolRegistryOptions = {},
): WebMcpPageToolRegistry | undefined {
  const doc = resolveDocument(options.document);
  if (!doc) return undefined;
  const existing = getWebMcpPageToolRegistry({ document: doc });
  if (existing) return existing;

  const slot = doc as { modelContext?: unknown };
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    doc,
    'modelContext',
  );
  const native = slot.modelContext;
  const nativeContext =
    native && typeof (native as ModelContextLike).registerTool === 'function'
      ? (native as ModelContextLike)
      : undefined;

  const tools = new Map<
    string,
    {
      registration: PageToolRegistration;
      descriptor: WebMcpPageToolDescriptor;
      token: object;
    }
  >();
  const listeners = new Set<(event: WebMcpPageToolEvent) => void>();
  const notify = (event: WebMcpPageToolEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener never breaks registration.
      }
    }
  };

  const registerTool = (
    tool: PageToolRegistration,
    registerOptions?: { signal?: AbortSignal },
  ): void | Promise<void> => {
    const signal = registerOptions?.signal;
    if (signal?.aborted) return;
    const annotations = { ...(tool.annotations ?? {}) };
    const descriptor: WebMcpPageToolDescriptor = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations,
      effect: stampedEffect(tool) ?? webMcpPageToolEffect(annotations),
      // Every SMRT registrar reserves the name before calling registerTool,
      // so the lock already knows who owns it.
      owner: webMcpToolNameOwner(tool.name, { document: doc }),
      proposal: isWebMcpProposalTool(tool.execute),
    };
    const token = {};
    tools.set(tool.name, { registration: tool, descriptor, token });
    notify({ type: 'registered', name: tool.name });
    signal?.addEventListener(
      'abort',
      () => {
        // Only drop the entry this registration made: a same-name
        // re-registration after the abort must survive it.
        if (tools.get(tool.name)?.token === token) {
          tools.delete(tool.name);
          notify({ type: 'unregistered', name: tool.name });
        }
      },
      { once: true },
    );
    if (!nativeContext) return;
    try {
      const forwarded = nativeContext.registerTool(tool, registerOptions);
      if (
        forwarded &&
        typeof (forwarded as Promise<void>).then === 'function'
      ) {
        return (forwarded as Promise<void>).catch((error: unknown) => {
          // The browser refused it: it is not live for outside agents either,
          // so it is not live here.
          if (tools.get(tool.name)?.token === token) {
            tools.delete(tool.name);
            notify({ type: 'unregistered', name: tool.name });
          }
          throw error;
        });
      }
      return forwarded;
    } catch (error) {
      if (tools.get(tool.name)?.token === token) {
        tools.delete(tool.name);
        notify({ type: 'unregistered', name: tool.name });
      }
      throw error;
    }
  };

  // Keep every other native member (and its `this`) reachable through the
  // installed context.
  const context: ModelContextLike = nativeContext
    ? (new Proxy(nativeContext as object, {
        get(target, property) {
          if (property === 'registerTool') return registerTool;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ModelContextLike)
    : { registerTool };

  const registry: WebMcpPageToolRegistry = {
    list: () => [...tools.values()].map((entry) => ({ ...entry.descriptor })),
    get: (name) => {
      const entry = tools.get(name);
      return entry ? { ...entry.descriptor } : undefined;
    },
    async execute(name, args, executeOptions) {
      const entry = tools.get(name);
      if (!entry) throw new WebMcpPageToolNotFoundError(name);
      return String(
        await entry.registration.execute(args ?? {}, executeOptions ?? {}),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    uninstall() {
      tools.clear();
      listeners.clear();
      if (previousDescriptor) {
        Object.defineProperty(doc, 'modelContext', previousDescriptor);
      } else {
        delete slot.modelContext;
      }
      delete (doc as Record<symbol, unknown>)[REGISTRY_KEY];
    },
  };

  Object.defineProperty(doc, 'modelContext', {
    value: context,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  Object.defineProperty(doc, REGISTRY_KEY, {
    value: registry,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return registry;
}
