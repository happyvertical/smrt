/**
 * Compile-time contract locks between the browser client (`client.ts`) and
 * the wire contract `chat-stream.ts` owns.
 *
 * This is deliberately a NON-TEST module: the typecheck tsconfig excludes
 * `.test.ts` files and Vitest transpiles without typechecking, so locks inside
 * a test file would enforce nothing (PR #2033 review). Here they sit in the
 * `pnpm typecheck` program, so server-side drift in `ChatStreamEvent` /
 * `ChatStreamSession` breaks the build instead of silently breaking clients.
 *
 * Nothing imports this module — it is type-only ballast and never reaches a
 * runtime bundle (the vite entries don't reference it), keeping the `/client`
 * subpath free of server imports.
 */

import type { ChatStreamEvent, ChatStreamSession } from './chat-stream.js';
import type { ChatClientStreamFrame, SmrtChatSession } from './client.js';

// Every frame the server can emit parses as a client frame…
const _frameCompat = (event: ChatStreamEvent): ChatClientStreamFrame => event;
void _frameCompat;

// …and the client's session binding is a valid wire session.
const _sessionCompat = (
  session: Required<SmrtChatSession>,
): ChatStreamSession => session;
void _sessionCompat;
