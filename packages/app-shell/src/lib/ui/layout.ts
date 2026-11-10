// Pure helpers behind the shell's layout (routes/+layout.svelte): where the
// chat column's open/closed choice is kept, and when the shell runs as a
// plugin inside Claude, Codex or ChatGPT (where the host app is the chat).

/** Sent (by the welcome steps) to ask the layout to open the chat column. */
export const ASSISTANT_OPEN_EVENT = 'smrt-app-shell:open-assistant';

// Connection settings notify the mounted dock without resetting its conversation.
export const ASSISTANT_STATUS_EVENT = 'smrt-app-shell:assistant-status';

export function refreshAssistantStatus(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(ASSISTANT_STATUS_EVENT));
}

const OPEN_KEY = 'smrt-app-shell:assistant-open';

/** The storage key for one owner's chat column choice. */
export function assistantOpenKey(ownerId?: string | null): string {
  return ownerId ? `${OPEN_KEY}:${ownerId}` : OPEN_KEY;
}

/**
 * The key the shell keeps one owner's layout preferences under (the chat
 * column's width, sidebar state): the smrt-svelte shell settings adapter.
 */
export function shellStorageKey(ownerId?: string | null): string {
  return ownerId ? `smrt-app-shell:layout:${ownerId}` : 'smrt-app-shell';
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** The remembered choice; the chat column is open until the owner closes it. */
export function readAssistantOpen(
  storage: ReadableStorage | null | undefined,
  key: string,
): boolean {
  try {
    return storage?.getItem(key) !== '0';
  } catch {
    return true;
  }
}

export function writeAssistantOpen(
  storage: WritableStorage | null | undefined,
  key: string,
  open: boolean,
): void {
  try {
    storage?.setItem(key, open ? '1' : '0');
  } catch {
    // storage is optional
  }
}

/**
 * Whether a page request is the shell loading as a plugin view: the browser
 * says the document goes into an `<iframe>` (an MCP App host renders the view
 * in one), or the host asked with `?embed=plugin`. A window that is not an
 * iframe (the desktop app, a browser tab) is never a plugin.
 */
export function isPluginRequest(request: {
  secFetchDest?: string | null;
  embed?: string | null;
}): boolean {
  return request.secFetchDest === 'iframe' || request.embed === 'plugin';
}

/** Client-side check for the same thing: the page is framed by another page. */
export function isFramed(win: { self: unknown; top: unknown } | undefined) {
  if (!win) return false;
  try {
    return win.self !== win.top;
  } catch {
    // A cross-origin parent: still framed.
    return true;
  }
}

/** What the layout shows, from where it runs. */
export interface LayoutPlan {
  /** The chat column and its toggles exist. */
  chat: boolean;
  /** The voice toggle exists. */
  voice: boolean;
}

/** In a plugin the host app is the chat: sidebar and content only. */
export function planLayout(options: {
  owner: boolean;
  plugin: boolean;
}): LayoutPlan {
  const chat = options.owner && !options.plugin;
  return { chat, voice: chat };
}
