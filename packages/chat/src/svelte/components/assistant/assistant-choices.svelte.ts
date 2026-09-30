/**
 * Choices: the assistant offers 1–4 options, the person picks one.
 *
 * The proposal counterpart of `assistant_propose_action` for work that has
 * several good answers — "crop this tighter", "find me a picture of the
 * arena". The page registers a {@link AssistantChoiceSource} while it can
 * serve one; the dock offers each source to the model as a browser tool
 * (`assistant_offer_<source id>`, effect `read`). When the model calls it the
 * dock asks the SOURCE for the options (the model never supplies them), shows
 * them as cards in the chat, and returns only their ids and labels to the
 * model. Nothing changes until the person clicks a card: only then does the
 * dock call the source's `apply`, in the page, as the person. The model has
 * no way to apply an option.
 *
 * Images on the cards are restricted to same-origin paths (`/…`), so a
 * source cannot leak a signed provider URL and an injected prompt cannot make
 * the dock load a remote address.
 */

import type {
  AssistantClientToolCall,
  AssistantClientToolResult,
} from '../../../assistant-turn-events.js';
import type { AssistantClientTool } from './client-tools.js';

/** Tool-name prefix for choice sources (add `assistant_offer_*` to a server allow-list). */
export const ASSISTANT_CHOICE_TOOL_PREFIX = 'assistant_offer_';

/** At most this many options are shown for one offer. */
export const ASSISTANT_CHOICE_MAX_OPTIONS = 4;

/** One option the person can pick. */
export interface AssistantChoiceOption {
  /** Stable within the offer; what `apply` receives back. */
  id: string;
  /** Short plain label ("Square", "Arena at night"). */
  label: string;
  /** One optional plain sentence under the label. */
  description?: string;
  /** Same-origin preview path (`/…`); anything else is dropped. */
  imageUrl?: string;
  /** Alt text for the preview; defaults to the label. */
  imageAlt?: string;
  /** Source-owned data carried to `apply` (never shown, never sent to the model). */
  value?: unknown;
}

/** What a source offers for one request. */
export interface AssistantChoiceOffer {
  /** A plain heading for the cards ("Pick a crop"). */
  title: string;
  options: AssistantChoiceOption[];
}

/** A page feature that can offer choices while it is on screen. */
export interface AssistantChoiceSource {
  /** Lowercase id, `[a-z][a-z0-9_]*`, at most 40 characters. */
  id: string;
  /** What the options are and when to offer them, for the model. */
  description: string;
  /** JSON schema of the model's arguments (default: none). */
  inputSchema?: Record<string, unknown>;
  /**
   * Build the options for the model's arguments. Throw an `Error` with a
   * plain message when there is nothing to offer; the model sees it.
   */
  offer(
    args: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<AssistantChoiceOffer> | AssistantChoiceOffer;
  /**
   * Apply the option the person clicked. Runs in the page on their click.
   * May return a short plain line saying what changed.
   */
  apply(
    option: AssistantChoiceOption,
  ): Promise<string | undefined | void> | string | undefined | void;
}

/** Where the dock finds the choice sources the page has registered. */
export interface AssistantChoiceSourceRegistry {
  /** Register a source; returns the function that removes it. */
  register(source: AssistantChoiceSource): () => void;
  list(): AssistantChoiceSource[];
}

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** A simple in-memory registry; the latest registration of an id wins. */
export function createAssistantChoiceSourceRegistry(): AssistantChoiceSourceRegistry {
  // Raw: sources are host objects compared by identity, never deep-proxied.
  let sources = $state.raw<AssistantChoiceSource[]>([]);
  return {
    register(source) {
      if (!SOURCE_ID_PATTERN.test(source.id)) {
        throw new Error(`Invalid choice source id "${source.id}"`);
      }
      sources = [...sources.filter((s) => s.id !== source.id), source];
      return () => {
        sources = sources.filter((s) => s !== source);
      };
    },
    list() {
      return sources;
    },
  };
}

/** The browser tool name for a source. */
export function choiceToolName(sourceId: string): string {
  return `${ASSISTANT_CHOICE_TOOL_PREFIX}${sourceId}`;
}

/** A same-origin path, or null. Rejects `//host`, `\\`, schemes, and controls. */
export function safeChoiceImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!/^\/(?![/\\])/.test(url)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\s\\]/.test(url)) return null;
  return url;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Normalize a source's options: unique ids, plain labels, safe images, at most 4. */
export function normalizeChoiceOptions(
  options: readonly AssistantChoiceOption[],
): AssistantChoiceOption[] {
  const seen = new Set<string>();
  const result: AssistantChoiceOption[] = [];
  for (const option of options) {
    const id = clean(option?.id, 120);
    const label = clean(option?.label, 80);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const description = clean(option.description, 160);
    const imageUrl = safeChoiceImageUrl(option.imageUrl);
    result.push({
      id,
      label,
      ...(description ? { description } : {}),
      ...(imageUrl
        ? { imageUrl, imageAlt: clean(option.imageAlt, 120) || label }
        : {}),
      ...(option.value !== undefined ? { value: option.value } : {}),
    });
    if (result.length >= ASSISTANT_CHOICE_MAX_OPTIONS) break;
  }
  return result;
}

/** One offer shown in the chat. */
export interface AssistantChoiceSet {
  /** The model's call id. */
  id: string;
  sourceId: string;
  title: string;
  options: AssistantChoiceOption[];
  /**
   * `waiting` for the person; `applying` after a click; `applied` once the
   * source applied it; `dismissed` when the person said none (or a newer
   * request replaced it); `failed` when applying failed (they may pick again).
   */
  status: 'waiting' | 'applying' | 'applied' | 'dismissed' | 'failed';
  chosenOptionId?: string;
  /** The source's line about what changed. */
  outcome?: string;
  error?: string;
}

/** The dock's choice state: offers from tool calls, and the person's picks. */
export class AssistantChoices {
  sets = $state<AssistantChoiceSet[]>([]);

  /** Release functions of the holds for offers still open. */
  private readonly releases = new Map<string, () => void>();

  /**
   * @param hold Called for each offer while it waits for the person (and
   *   after a failed apply); returns the release, called once they picked,
   *   dismissed, or the offer was replaced. The dock uses its run holds.
   */
  constructor(
    private readonly getRegistry: () =>
      | AssistantChoiceSourceRegistry
      | undefined,
    private readonly hold?: (set: AssistantChoiceSet) => () => void,
  ) {}

  /** Keep one hold per open offer (`waiting` or `failed`). */
  private syncHolds() {
    const open = new Set(
      this.sets
        .filter((set) => set.status === 'waiting' || set.status === 'failed')
        .map((set) => set.id),
    );
    for (const [id, release] of this.releases) {
      if (!open.has(id)) {
        release();
        this.releases.delete(id);
      }
    }
    if (!this.hold) return;
    for (const set of this.sets) {
      if (open.has(set.id) && !this.releases.has(set.id)) {
        this.releases.set(set.id, this.hold(set));
      }
    }
  }

  private sources(): AssistantChoiceSource[] {
    return (this.getRegistry()?.list() ?? []).filter((source) =>
      SOURCE_ID_PATTERN.test(source.id),
    );
  }

  private source(id: string): AssistantChoiceSource | undefined {
    return this.sources().find((source) => source.id === id);
  }

  /** The browser tools for the registered sources. */
  tools(): AssistantClientTool[] {
    return this.sources().map((source) => ({
      name: choiceToolName(source.id),
      description: [
        source.description.slice(0, 800),
        'Shows the options as cards in the chat; the person picks one and it is applied then. You cannot apply it yourself. Tell them to pick one.',
      ].join('\n'),
      inputSchema: source.inputSchema ?? {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      effect: 'read',
    }));
  }

  isChoiceTool(name: string): boolean {
    return (
      name.startsWith(ASSISTANT_CHOICE_TOOL_PREFIX) &&
      Boolean(this.source(name.slice(ASSISTANT_CHOICE_TOOL_PREFIX.length)))
    );
  }

  /** Number of offers waiting for the person. */
  get waitingCount(): number {
    return this.sets.filter((set) => set.status === 'waiting').length;
  }

  private update(id: string, patch: Partial<AssistantChoiceSet>) {
    this.sets = this.sets.map((set) =>
      set.id === id ? { ...set, ...patch } : set,
    );
    this.syncHolds();
  }

  /** Run a model call to a choice tool: ask the source, show the cards. */
  async offerFromCall(
    call: AssistantClientToolCall,
    signal?: AbortSignal,
  ): Promise<AssistantClientToolResult> {
    const sourceId = call.name.slice(ASSISTANT_CHOICE_TOOL_PREFIX.length);
    const source = this.source(sourceId);
    if (!source) return { id: call.id, ok: false, error: 'not_available' };
    let offer: AssistantChoiceOffer;
    try {
      offer = await source.offer(call.args ?? {}, { signal });
    } catch (err) {
      return {
        id: call.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const options = normalizeChoiceOptions(offer?.options ?? []);
    if (options.length === 0) {
      return { id: call.id, ok: false, error: 'Nothing to offer.' };
    }
    const set: AssistantChoiceSet = {
      id: call.id,
      sourceId,
      title: clean(offer.title, 120) || 'Pick one',
      options,
      status: 'waiting',
    };
    this.sets = [...this.sets.filter((s) => s.id !== call.id), set];
    this.syncHolds();
    return {
      id: call.id,
      ok: true,
      result: JSON.stringify({
        offered: true,
        waitingForUser: true,
        options: options.map(({ id, label }) => ({ id, label })),
      }),
    };
  }

  /** The person picked `optionId`: apply it through its source. */
  async choose(setId: string, optionId: string): Promise<void> {
    const set = this.sets.find((s) => s.id === setId);
    if (!set || (set.status !== 'waiting' && set.status !== 'failed')) return;
    const option = set.options.find((o) => o.id === optionId);
    if (!option) return;
    const source = this.source(set.sourceId);
    if (!source) {
      this.update(setId, {
        status: 'failed',
        error: 'This is no longer on the page.',
      });
      return;
    }
    this.update(setId, {
      status: 'applying',
      chosenOptionId: optionId,
      error: undefined,
    });
    try {
      const outcome = await source.apply(option);
      this.update(setId, {
        status: 'applied',
        ...(typeof outcome === 'string' && outcome.trim()
          ? { outcome: outcome.trim().slice(0, 200) }
          : {}),
      });
    } catch (err) {
      this.update(setId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The person wants none of these. */
  dismiss(setId: string) {
    const set = this.sets.find((s) => s.id === setId);
    if (set && (set.status === 'waiting' || set.status === 'failed')) {
      this.update(setId, { status: 'dismissed' });
    }
  }

  /** A new request replaces offers still waiting. */
  supersedeWaiting() {
    if (this.waitingCount === 0) return;
    this.sets = this.sets.map((set) =>
      set.status === 'waiting' ? { ...set, status: 'dismissed' as const } : set,
    );
    this.syncHolds();
  }

  clear() {
    this.sets = [];
    this.syncHolds();
  }
}
