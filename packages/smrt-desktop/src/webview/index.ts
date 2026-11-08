/**
 * Browser-safe helper for the signed-in, same-origin desktop webview.
 *
 * Imports no Node built-ins and has no runtime dependency (the Tauri `invoke`
 * function and `fetch` are injected). It performs the #4726 mint, hands the
 * RAW response text to a single native command and returns non-secret status
 * only. Rules the code below keeps, and its tests enforce:
 *
 * - the response text is never parsed, stored, logged or returned: it exists
 *   as one local string between `res.text()` and the `desktop-credential-put`
 *   call, and no native command returns a bearer to the page;
 * - no `localStorage`, `sessionStorage`, `IndexedDB`, cookie, `console`,
 *   `location`, `history` or URL construction is touched;
 * - every thrown error is a `DesktopContractError` with a fixed message; the
 *   underlying rejection (which could echo a body) is dropped, never chained;
 * - a lost or unknown outcome repeats the PUT with the SAME slot id (#4726
 *   retry semantics); a revoked slot (409) moves to a fresh slot id;
 *   disconnect revokes on the server first and only then forgets locally.
 */

import { isScopeList } from '../credentials/grammar.js';
import { DesktopContractError } from '../errors.js';
import { isIsoUtcTimestamp, isUuidV4 } from '../internal/grammar.js';
import { hasClosedKeys, isRecord } from '../internal/strict-json.js';

/** The route the desktop product mounts `createLocalMcpCredentialHandler` on. */
export const DESKTOP_CREDENTIAL_ENDPOINT = '/api/local/mcp-credentials';

/** Native commands. None of them returns the bearer to JavaScript. */
export const DESKTOP_CREDENTIAL_COMMANDS = Object.freeze({
  /** Get or create the persisted slot (`{ action: 'ensure' | 'replace' }`). */
  slot: 'desktop-credential-slot',
  /** Validate and store the raw mint response (`{ slotId, body }`). */
  put: 'desktop-credential-put',
  /** Non-secret slot status. */
  status: 'desktop-credential-status',
  /** Mark revoked (after a server revoke) or revoking (`{ slotId, revoked }`). */
  forget: 'desktop-credential-forget',
});

export interface DesktopCredentialCommands {
  readonly slot: string;
  readonly put: string;
  readonly status: string;
  readonly forget: string;
}

/** Tauri's `invoke`, structurally. */
export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface MintFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly credentials: 'same-origin';
  readonly cache: 'no-store';
  readonly redirect: 'error';
  readonly referrerPolicy: 'no-referrer';
  readonly signal?: AbortSignal;
}

/** The part of `Response` the helper uses. */
export interface MintFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type MintFetch = (
  input: string,
  init: MintFetchInit,
) => Promise<MintFetchResponse>;

export interface DesktopAssistantOptions {
  readonly invoke: TauriInvoke;
  readonly fetch: MintFetch;
  /** Defaults to `DESKTOP_CREDENTIAL_ENDPOINT` (a relative, same-origin URL). */
  readonly endpoint?: string;
  /** Override the native command names (default `DESKTOP_CREDENTIAL_COMMANDS`). */
  readonly commands?: DesktopCredentialCommands;
  /** Attempts per request before giving up. Defaults to 3, at most 5. */
  readonly maxAttempts?: number;
  /** Test seam for the retry delay. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ConnectDesktopAssistantOptions
  extends DesktopAssistantOptions {
  /** Permission slugs the credential may use. */
  readonly scopes: readonly string[];
  /** 60 to 31,536,000 seconds (the server limit). */
  readonly expiresInSeconds: number;
}

/** Non-secret status. `expiresAt` is compared to the clock by the caller. */
export type DesktopAssistantStatus =
  | { readonly state: 'none' }
  | {
      readonly state: 'connected';
      readonly slotId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: string;
    }
  | {
      readonly state: 'revoking' | 'revoked';
      readonly slotId: string;
    };

const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const MAX_SLOT_REPLACEMENTS = 2;
const MAX_LIFETIME_SECONDS = 31_536_000;
const MIN_LIFETIME_SECONDS = 60;

function fail(
  code: ConstructorParameters<typeof DesktopContractError>[0],
): DesktopContractError {
  return new DesktopContractError(code);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Context {
  readonly invoke: TauriInvoke;
  readonly fetch: MintFetch;
  readonly endpoint: string;
  readonly commands: DesktopCredentialCommands;
  readonly attempts: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal | undefined;
}

function context(options: DesktopAssistantOptions): Context {
  if (
    typeof options?.invoke !== 'function' ||
    typeof options.fetch !== 'function'
  ) {
    throw fail('credential_request_failed');
  }
  const attempts = Math.min(
    Math.max(Math.trunc(options.maxAttempts ?? DEFAULT_ATTEMPTS), 1),
    MAX_ATTEMPTS,
  );
  return {
    invoke: options.invoke,
    fetch: options.fetch,
    endpoint: options.endpoint ?? DESKTOP_CREDENTIAL_ENDPOINT,
    commands: options.commands ?? DESKTOP_CREDENTIAL_COMMANDS,
    attempts: Number.isFinite(attempts) ? attempts : DEFAULT_ATTEMPTS,
    sleep: options.sleep ?? defaultSleep,
    signal: options.signal,
  };
}

interface NativeSlot {
  readonly slotId: string;
  readonly state: 'minted' | 'revoking' | 'revoked';
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
}

const slotKeys = ['slotId', 'state', 'scopes', 'expiresAt'];

/** Validate a native slot reply; the page never sees more than this. */
function readSlot(reply: unknown): NativeSlot {
  if (
    !isRecord(reply) ||
    !hasClosedKeys(reply, slotKeys) ||
    !isUuidV4(reply.slotId) ||
    (reply.state !== 'minted' &&
      reply.state !== 'revoking' &&
      reply.state !== 'revoked') ||
    !isScopeList(reply.scopes) ||
    (reply.expiresAt !== null && !isIsoUtcTimestamp(reply.expiresAt))
  ) {
    throw fail('invalid_native_response');
  }
  return {
    slotId: reply.slotId,
    state: reply.state,
    scopes: [...reply.scopes],
    expiresAt: reply.expiresAt,
  };
}

async function callNative(
  ctx: Context,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ctx.invoke(command, args);
  } catch {
    // The rejection may echo what was sent; drop it.
    throw fail('native_rejected');
  }
}

async function nativeSlot(
  ctx: Context,
  action: 'ensure' | 'replace',
): Promise<NativeSlot> {
  return readSlot(await callNative(ctx, ctx.commands.slot, { action }));
}

function aborted(ctx: Context): boolean {
  return ctx.signal?.aborted === true;
}

async function backoff(ctx: Context, attempt: number): Promise<void> {
  await ctx.sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
}

type PostOutcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'slot_unavailable' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'rejected' };

/** One POST. Never throws; never exposes more than the classified outcome. */
async function post(ctx: Context, payload: unknown): Promise<PostOutcome> {
  let response: MintFetchResponse;
  try {
    response = await ctx.fetch(ctx.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch {
    return { kind: 'retry' };
  }
  const status = response?.status;
  if (status === 200) {
    try {
      return { kind: 'ok', text: await response.text() };
    } catch {
      return { kind: 'retry' };
    }
  }
  if (status === 409) return { kind: 'slot_unavailable' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    return { kind: 'retry' };
  }
  return { kind: 'rejected' };
}

interface PutReply {
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

const putKeys = ['status', 'scopes', 'expiresAt'];

function readPutReply(reply: unknown): PutReply {
  if (
    !isRecord(reply) ||
    !hasClosedKeys(reply, putKeys) ||
    reply.status !== 'active' ||
    !isScopeList(reply.scopes) ||
    !isIsoUtcTimestamp(reply.expiresAt)
  ) {
    throw fail('invalid_native_response');
  }
  return { scopes: [...reply.scopes], expiresAt: reply.expiresAt };
}

/**
 * PUT the slot (repeating with the same id when the outcome is unknown), hand
 * the raw reply to the native put command and return its non-secret reply, or
 * `null` when the server says the slot id is unusable (409).
 */
async function putSlot(
  ctx: Context,
  slotId: string,
  scopes: readonly string[],
  expiresInSeconds: number,
): Promise<PutReply | null> {
  let nativeFailed = false;
  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    if (aborted(ctx)) throw fail('credential_request_failed');
    const outcome = await post(ctx, {
      action: 'put',
      id: slotId,
      scopes,
      expiresInSeconds,
    });
    if (outcome.kind === 'slot_unavailable') return null;
    if (outcome.kind === 'forbidden') throw fail('credential_forbidden');
    if (outcome.kind === 'rejected') throw fail('credential_rejected');
    if (outcome.kind === 'ok') {
      let reply: unknown;
      try {
        // The response text goes to exactly one place: the native command.
        reply = await ctx.invoke(ctx.commands.put, {
          slotId,
          body: outcome.text,
        });
      } catch {
        nativeFailed = true;
        reply = undefined;
      }
      // A committed credential is never re-minted because of a bad reply.
      if (!nativeFailed) return readPutReply(reply);
    }
    if (attempt < ctx.attempts) await backoff(ctx, attempt);
  }
  throw fail(nativeFailed ? 'native_rejected' : 'credential_request_failed');
}

/**
 * Revoke on the server (repeating on unknown outcomes; `revoked` and 409 both
 * mean done), then tell the native side to forget. Returns whether the server
 * confirmed.
 */
async function revokeSlot(
  ctx: Context,
  slotId: string,
): Promise<'revoked' | 'revoking'> {
  let confirmed = false;
  for (let attempt = 1; attempt <= ctx.attempts && !aborted(ctx); attempt++) {
    const outcome = await post(ctx, { action: 'revoke', id: slotId });
    if (outcome.kind === 'ok' || outcome.kind === 'slot_unavailable') {
      confirmed = true;
      break;
    }
    if (outcome.kind === 'forbidden' || outcome.kind === 'rejected') break;
    if (attempt < ctx.attempts) await backoff(ctx, attempt);
  }
  // Server first, then local: an unconfirmed revoke only marks the slot
  // `revoking` (the shell stops serving it) and keeps the id for a retry.
  const reply = await callNative(ctx, ctx.commands.forget, {
    slotId,
    revoked: confirmed,
  });
  if (
    !isRecord(reply) ||
    !hasClosedKeys(reply, ['status']) ||
    (reply.status !== 'revoked' && reply.status !== 'revoking')
  ) {
    throw fail('invalid_native_response');
  }
  return reply.status;
}

/**
 * Connect (or rotate) the desktop assistant credential from the signed-in
 * same-origin webview. Safe to call again at any time: it reuses the persisted
 * slot (a rotation is a new PUT on the same id), finishes a pending revoke
 * first, and moves to a new slot id when the server reports the id unusable.
 */
export async function connectDesktopAssistant(
  options: ConnectDesktopAssistantOptions,
): Promise<Extract<DesktopAssistantStatus, { state: 'connected' }>> {
  const ctx = context(options);
  const { scopes, expiresInSeconds } = options;
  if (
    !isScopeList(scopes) ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_LIFETIME_SECONDS ||
    expiresInSeconds > MAX_LIFETIME_SECONDS
  ) {
    throw fail('credential_rejected');
  }

  let slot = await nativeSlot(ctx, 'ensure');
  if (slot.state === 'revoking') {
    if ((await revokeSlot(ctx, slot.slotId)) !== 'revoked') {
      throw fail('slot_unavailable');
    }
    slot = await nativeSlot(ctx, 'replace');
  } else if (slot.state === 'revoked') {
    slot = await nativeSlot(ctx, 'replace');
  }

  for (let replacement = 0; ; replacement++) {
    const result = await putSlot(ctx, slot.slotId, scopes, expiresInSeconds);
    if (result !== null) {
      return {
        state: 'connected',
        slotId: slot.slotId,
        scopes: result.scopes,
        expiresAt: result.expiresAt,
      };
    }
    if (replacement >= MAX_SLOT_REPLACEMENTS) throw fail('slot_unavailable');
    slot = await nativeSlot(ctx, 'replace');
  }
}

async function readNativeStatus(
  invoke: TauriInvoke,
  commands: DesktopCredentialCommands,
): Promise<NativeSlot | null> {
  let reply: unknown;
  try {
    reply = await invoke(commands.status, {});
  } catch {
    throw fail('native_rejected');
  }
  return reply === null ? null : readSlot(reply);
}

/** Non-secret status of the persisted slot. */
export async function getDesktopAssistantStatus(
  options: Pick<DesktopAssistantOptions, 'invoke' | 'commands'>,
): Promise<DesktopAssistantStatus> {
  if (typeof options?.invoke !== 'function') {
    throw fail('credential_request_failed');
  }
  const slot = await readNativeStatus(
    options.invoke,
    options.commands ?? DESKTOP_CREDENTIAL_COMMANDS,
  );
  if (slot === null) return { state: 'none' };
  if (slot.state === 'minted') {
    return slot.expiresAt === null
      ? { state: 'none' }
      : {
          state: 'connected',
          slotId: slot.slotId,
          scopes: slot.scopes,
          expiresAt: slot.expiresAt,
        };
  }
  return { state: slot.state, slotId: slot.slotId };
}

/**
 * Disconnect: revoke the slot on the server, then forget it locally. When the
 * server cannot be reached the slot is marked `revoking` (the shell stops
 * serving the credential at once) and the status says so; the next connect or
 * disconnect finishes the revoke. With no slot at all it returns `none`.
 *
 * A slot that was minted but never committed is revoked too: #4726 makes a
 * revoke permanent for the id, so a delayed PUT cannot resurrect it.
 */
export async function disconnectDesktopAssistant(
  options: DesktopAssistantOptions,
): Promise<DesktopAssistantStatus> {
  const ctx = context(options);
  const slot = await readNativeStatus(ctx.invoke, ctx.commands);
  if (slot === null) return { state: 'none' };
  if (slot.state === 'revoked')
    return { state: 'revoked', slotId: slot.slotId };
  const state = await revokeSlot(ctx, slot.slotId);
  return { state, slotId: slot.slotId };
}
