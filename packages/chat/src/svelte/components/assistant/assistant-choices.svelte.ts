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
 *
 * Options that take a while (generated pictures) arrive later: the offer
 * carries `pending`, the cards show "Making…" placeholders and the source's
 * `fill` adds options as they finish. The person can pick any option that
 * has arrived. Such an offer is not replaced by the person's next message
 * (it cost real work); "None of these" stops it.
 *
 * Previewing: a source that implements `preview` shows a pick in place on
 * the page WITHOUT applying it. A click on a card only previews (another
 * click swaps the preview; the offer's `original` card shows the page as it
 * was); nothing is committed until the person presses the offer's commit
 * button (`commit`, which applies the previewed option and resolves the
 * offer). Cancel (`cancel`), dismissing, clearing the conversation and
 * disposing all restore the original. The model still only offers.
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

/** How a pending offer reports progress (see {@link AssistantChoicePending}). */
export interface AssistantChoicePendingUpdate {
  /** Add finished options (normalized; at most 4 in the whole offer). */
  add(options: AssistantChoiceOption[]): void;
  /** Replace the plain progress line. */
  status(message: string): void;
}

/** Options still being made, added to the cards as they finish. */
export interface AssistantChoicePending {
  /** A plain line while they are made ("Making versions… about a minute"). */
  message: string;
  /** How many options are coming, for placeholders (1–4; default 4 less the ready ones). */
  expected?: number;
  /**
   * Called once, after the cards show. Call `update.add` as options finish,
   * and resolve when there are no more. Throw an `Error` with a plain
   * message when making them failed; it is shown on the cards. `signal`
   * aborts when the person dismisses the offer (or picks an option, or the
   * conversation is cleared): stop polling then.
   */
  fill(
    update: AssistantChoicePendingUpdate,
    signal: AbortSignal,
  ): Promise<void>;
}

/** What a source offers for one request. */
export interface AssistantChoiceOffer {
  /** A plain heading for the cards ("Pick a crop"). */
  title: string;
  /** The ready options (may be empty when `pending` is set). */
  options: AssistantChoiceOption[];
  /** More options are being made; they are added as they finish. */
  pending?: AssistantChoicePending;
  /**
   * The page as it is now, shown as the first card ("Original") when the
   * source can `preview`: previewing it restores the page. Needs an image.
   */
  original?: AssistantChoiceOption;
  /** The commit button's label when previewing (default "Use this"). */
  commitLabel?: string;
  /** The cancel button's label when previewing (default "Cancel"). */
  cancelLabel?: string;
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
  /**
   * Show `option` in place on the page WITHOUT saving or applying it, so the
   * person can see it before committing. `option` is the offer's `original`
   * to put the page back (or null when the offer had none). Runs in the page
   * on the person's click; must never persist anything. A source that
   * implements this gets preview-then-commit cards; one that does not keeps
   * "click applies".
   */
  preview?(option: AssistantChoiceOption | null): Promise<void> | void;
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
   * `waiting` for the person (options may still be arriving, see `pending`);
   * `applying` after a click; `applied` once the source applied it;
   * `dismissed` when the person said none (or a newer request replaced it);
   * `failed` when applying failed (they may pick again); `unavailable` when
   * the pending options could not be made and none arrived.
   */
  status:
    | 'waiting'
    | 'applying'
    | 'applied'
    | 'dismissed'
    | 'failed'
    | 'unavailable';
  chosenOptionId?: string;
  /** The source's line about what changed. */
  outcome?: string;
  error?: string;
  /** Options still being made: the progress line and how many are coming. */
  pending?: { message: string; expected: number };
  /** A plain line when some pending options could not be made. */
  note?: string;
  /** Kept when the person sends another message (it had pending work). */
  lasting?: boolean;
  /** The source can preview: a click previews, the commit button applies. */
  previewable?: boolean;
  /** The page as it is now (previewable offers): the "Original" card. */
  original?: AssistantChoiceOption;
  /** The option (or the original) now previewed; nothing is applied yet. */
  previewOptionId?: string;
  /**
   * The option whose preview is being shown right now (the source has not
   * finished). Cards and the commit button wait for it, so what is committed
   * is always what the page shows.
   */
  previewPendingId?: string;
  commitLabel?: string;
  cancelLabel?: string;
}

/** The dock's choice state: offers from tool calls, and the person's picks. */
export class AssistantChoices {
  sets = $state<AssistantChoiceSet[]>([]);

  /** Release functions of the holds for offers still open. */
  private readonly releases = new Map<string, () => void>();
  /**
   * Per-offer preview queue and request counter: previews run one at a time
   * in click order, so the page ends on the last click, and only the latest
   * request updates the offer.
   */
  private readonly previewQueues = new Map<string, Promise<void>>();
  private readonly previewRequests = new Map<string, number>();

  /** Abort controllers of pending offers still being filled. */
  private readonly fills = new Map<string, AbortController>();

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

  /** The progress line of an offer still being made with nothing to pick yet. */
  get pendingMessage(): string | null {
    const making = this.sets.find(
      (set) =>
        set.status === 'waiting' && set.pending && set.options.length === 0,
    );
    return making?.pending?.message ?? null;
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
    const pending =
      offer?.pending && typeof offer.pending.fill === 'function'
        ? offer.pending
        : null;
    const options = normalizeChoiceOptions(offer?.options ?? []);
    if (options.length === 0 && !pending) {
      return { id: call.id, ok: false, error: 'Nothing to offer.' };
    }
    const pendingState = pending
      ? {
          message: clean(pending.message, 160) || 'Making options…',
          expected: Math.min(
            ASSISTANT_CHOICE_MAX_OPTIONS - options.length,
            Math.max(1, Math.floor(Number(pending.expected) || 0) || 4),
          ),
        }
      : undefined;
    const previewable = typeof source.preview === 'function';
    const original = previewable
      ? normalizeChoiceOptions(offer?.original ? [offer.original] : [])[0]
      : undefined;
    const set: AssistantChoiceSet = {
      id: call.id,
      sourceId,
      title: clean(offer.title, 120) || 'Pick one',
      options: options.filter((option) => option.id !== original?.id),
      status: 'waiting',
      ...(previewable
        ? {
            previewable: true,
            ...(original ? { original } : {}),
            commitLabel: clean(offer.commitLabel, 40) || 'Use this',
            cancelLabel: clean(offer.cancelLabel, 40) || 'Cancel',
          }
        : {}),
      ...(pendingState && pendingState.expected > 0
        ? { pending: pendingState, lasting: true }
        : {}),
    };
    this.sets = [...this.sets.filter((s) => s.id !== call.id), set];
    this.syncHolds();
    if (pending && set.pending) this.fill(set.id, pending);
    return {
      id: call.id,
      ok: true,
      result: JSON.stringify({
        offered: true,
        waitingForUser: true,
        ...(set.pending
          ? { stillMaking: true, progress: set.pending.message }
          : {}),
        options: options.map(({ id, label }) => ({ id, label })),
      }),
    };
  }

  /** Run a pending offer's `fill`, adding its options as they finish. */
  private fill(setId: string, pending: AssistantChoicePending) {
    const controller = new AbortController();
    this.fills.get(setId)?.abort();
    this.fills.set(setId, controller);
    const live = () =>
      !controller.signal.aborted
        ? this.sets.find((s) => s.id === setId && s.status !== 'dismissed')
        : undefined;
    const update: AssistantChoicePendingUpdate = {
      add: (added) => {
        const set = live();
        if (!set) return;
        const options = normalizeChoiceOptions([
          ...set.options,
          ...(Array.isArray(added) ? added : []),
        ]);
        const remaining = set.pending
          ? Math.max(
              0,
              Math.min(
                ASSISTANT_CHOICE_MAX_OPTIONS,
                set.options.length + set.pending.expected,
              ) - options.length,
            )
          : 0;
        this.update(setId, {
          options,
          ...(set.pending
            ? { pending: { ...set.pending, expected: remaining } }
            : {}),
        });
      },
      status: (message) => {
        const set = live();
        const text = clean(message, 160);
        if (set?.pending && text) {
          this.update(setId, { pending: { ...set.pending, message: text } });
        }
      },
    };
    const finish = (err: unknown) => {
      if (this.fills.get(setId) === controller) this.fills.delete(setId);
      const set = live();
      if (!set) return;
      const message =
        err == null
          ? null
          : (err instanceof Error ? err.message : String(err)).slice(0, 200);
      if (set.options.length === 0) {
        this.update(setId, {
          status: 'unavailable',
          pending: undefined,
          error: message || 'Nothing came back. Try again.',
        });
      } else {
        this.update(setId, {
          pending: undefined,
          ...(message ? { note: message } : {}),
        });
      }
    };
    Promise.resolve()
      .then(() => pending.fill(update, controller.signal))
      .then(
        () => finish(null),
        (err) => finish(err ?? 'Nothing came back. Try again.'),
      );
  }

  /** Stop filling an offer (it was picked, dismissed or cleared). */
  private stopFill(setId: string) {
    this.fills.get(setId)?.abort();
    this.fills.delete(setId);
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
      // Picked: versions still being made are no longer needed.
      this.stopFill(setId);
      this.update(setId, {
        status: 'applied',
        pending: undefined,
        previewOptionId: undefined,
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
    if (
      set &&
      (set.status === 'waiting' ||
        set.status === 'failed' ||
        set.status === 'unavailable')
    ) {
      this.stopFill(setId);
      void this.restorePreview(setId);
      this.update(setId, {
        status: 'dismissed',
        pending: undefined,
        previewOptionId: undefined,
        previewPendingId: undefined,
      });
    }
  }

  /**
   * Put the page back if this offer is previewing something (or is about
   * to). Queued behind any preview still running, and it cancels queued
   * ones, so a slow preview never lands after the page was restored.
   */
  private async restorePreview(setId: string): Promise<void> {
    const set = this.sets.find((s) => s.id === setId);
    if (
      !set?.previewable ||
      (set.previewOptionId === undefined && set.previewPendingId === undefined)
    ) {
      return;
    }
    this.previewRequests.set(setId, (this.previewRequests.get(setId) ?? 0) + 1);
    const { sourceId } = set;
    const original = set.original ?? null;
    const restore = async () => {
      try {
        await this.source(sourceId)?.preview?.(original);
      } catch {
        // Nothing more to do: the page is leaving or the picture is gone.
      }
    };
    const queued = (this.previewQueues.get(setId) ?? Promise.resolve()).then(
      restore,
    );
    this.previewQueues.set(setId, queued);
    await queued;
  }

  /**
   * The person clicked a card of a previewable offer (or its `original`):
   * show it in place. Nothing is applied.
   */
  async preview(setId: string, optionId: string): Promise<void> {
    const set = this.sets.find((s) => s.id === setId);
    if (
      !set?.previewable ||
      (set.status !== 'waiting' && set.status !== 'failed')
    ) {
      return;
    }
    const option =
      set.original?.id === optionId
        ? set.original
        : set.options.find((o) => o.id === optionId);
    const source = this.source(set.sourceId);
    if (!option || !source?.preview) return;
    const request = (this.previewRequests.get(setId) ?? 0) + 1;
    this.previewRequests.set(setId, request);
    const latest = () => this.previewRequests.get(setId) === request;
    this.update(setId, { previewPendingId: optionId });
    const run = async () => {
      // A newer click (or a restore) is queued behind this one: let it run
      // instead. A closed offer previews nothing.
      const current = this.sets.find((s) => s.id === setId);
      if (
        !latest() ||
        !current ||
        (current.status !== 'waiting' && current.status !== 'failed')
      ) {
        return;
      }
      // One preview at a time: put back any other offer's first.
      for (const other of this.sets) {
        if (other.id !== setId && other.previewOptionId !== undefined) {
          await this.restorePreview(other.id);
          this.update(other.id, { previewOptionId: undefined });
        }
      }
      try {
        await source.preview?.(option);
        if (!latest()) return;
        this.update(setId, {
          status: 'waiting',
          previewOptionId: optionId,
          previewPendingId: undefined,
          error: undefined,
        });
      } catch (err) {
        if (!latest()) return;
        this.update(setId, {
          status: 'failed',
          previewPendingId: undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const queued = (this.previewQueues.get(setId) ?? Promise.resolve()).then(
      run,
    );
    this.previewQueues.set(setId, queued);
    await queued;
  }

  /**
   * The person pressed the commit button: apply the previewed option (the
   * one thing that changes the page). The original, or nothing, previewed
   * means there is nothing to apply: that is a cancel.
   */
  async commit(setId: string): Promise<void> {
    const set = this.sets.find((s) => s.id === setId);
    // Never commit while a preview is still being shown: the option that
    // would be applied is not yet the one on the page.
    if (!set?.previewable || set.previewPendingId !== undefined) return;
    const id = set.previewOptionId;
    if (!id || id === set.original?.id) {
      this.cancel(setId);
      return;
    }
    await this.choose(setId, id);
  }

  /** The person wants to keep the original: restore it and close the offer. */
  cancel(setId: string): void {
    this.dismiss(setId);
  }

  /**
   * A new request replaces offers still waiting, except ones that had
   * options made for them (`lasting`): only the person dismisses those.
   */
  supersedeWaiting() {
    if (this.waitingCount === 0) return;
    for (const set of this.sets) {
      if (set.status === 'waiting' && !set.lasting) {
        void this.restorePreview(set.id);
      }
    }
    this.sets = this.sets.map((set) =>
      set.status === 'waiting' && !set.lasting
        ? {
            ...set,
            status: 'dismissed' as const,
            previewOptionId: undefined,
            previewPendingId: undefined,
          }
        : set,
    );
    this.syncHolds();
  }

  clear() {
    for (const controller of this.fills.values()) controller.abort();
    this.fills.clear();
    // An uncommitted preview never outlives the conversation.
    for (const set of this.sets) void this.restorePreview(set.id);
    this.sets = [];
    this.syncHolds();
  }
}
