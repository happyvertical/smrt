/**
 * The identity `AppShell` reads from its `user` prop: an id for the signed-in
 * state, and the display fields the account menu shows. Structural on purpose,
 * so the runtime's `SessionLayoutUser` (`{ id, email, name? }`) and a full
 * `User` both satisfy it without a cast. `null` is signed out.
 */
export type ShellUser = {
  /** The user id (a not-yet-persisted `User` carries `null`/`undefined`). */
  readonly id: string | null | undefined;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly avatarUrl?: string | null;
} | null;
