import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDesktopWrapper } from './desktop.ts';

/**
 * A hand-off file is written right after its token is issued, so its age is the
 * token's age; the token lives 10 minutes (app-runtime
 * DEFAULT_BOOTSTRAP_TTL_SECONDS). At that age the token is dead, and the
 * runtime's next `ownerSetupLocation()` mints a new one.
 */
const HANDOFF_FRESH_MS = 10 * 60_000;
/** How often a running server renews an unclaimed link (well inside the token's life). */
const RENEW_EVERY_MS = 60_000;

/** The slice of the SvelteKit runtime the hand-off needs. */
export interface OwnerHandoffRuntime {
  resolvedRuntime(): Promise<{ readonly profile: string }>;
  applicationStateRoot(): string;
  ownerSetupLocation(): Promise<string>;
}

/**
 * First start (#5165): make sure a local owner has a one-time setup link to
 * land on, without any terminal step. `smrt app setup` / `recover` save the
 * link as `onboarding.json` (+ `onboarding-launch.html`) in the private state
 * folder and `smrt app open` follows it. A fresh data folder that is only
 * started (`smrt app start`, `node build`) issued the invitation in memory and
 * dropped it, so `open` went to `/`, which is signed out. This writes the same
 * hand-off, only when none exists or the saved one is older than the token's
 * lifetime (never replacing a link `setup` just saved) and
 * only while no owner exists.
 *
 * The token is never logged or returned: it goes only into two 0600 files in
 * the state folder that the claim removes. The desktop wrapper signs the owner
 * in through the owner link instead, so it gets no files. Failures are
 * swallowed: the app must still start, and `smrt app recover` still works.
 */
export async function ensureOwnerHandoff(
  runtime: OwnerHandoffRuntime,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    if (isDesktopWrapper(env)) return false;
    if ((await runtime.resolvedRuntime()).profile !== 'local') return false;
    const root = runtime.applicationStateRoot();
    const handoff = join(root, 'onboarding.json');
    // A saved link is kept while it can still be valid. The setup token lives
    // 10 minutes (app-runtime DEFAULT_BOOTSTRAP_TTL_SECONDS) and the file is
    // written after the token is issued, so an older file is a dead link: it is
    // replaced by this start's current invitation instead of sending `open` to
    // an expired page (an unexpired invitation is never rotated here).
    if (
      existsSync(handoff) &&
      Date.now() - statSync(handoff).mtimeMs < HANDOFF_FRESH_MS
    )
      return false;
    const location = await runtime.ownerSetupLocation();
    // '/' means an owner already exists (or nothing is issuable).
    if (!location.startsWith('/setup?token=')) return false;
    const url = `http://127.0.0.1:${env.PORT || '5173'}${location}`;
    // The runtime hands back the SAME token while it is valid. Never rewrite
    // the same link: that would reset the file's age and hide that it expired.
    if (existsSync(handoff) && savedUrl(handoff) === url) return false;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    // Launch page first: `open` follows it, `onboarding.json` marks it ready.
    writePrivate(
      join(root, 'onboarding-launch.html'),
      `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}">\n`,
    );
    writePrivate(handoff, `${JSON.stringify({ schemaVersion: 1, url })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the saved link alive while the server runs and no owner has claimed it:
 * a link left unopened past the token's life would send `open` to an expired
 * page. The claim removes the files, which ends the loop. Unref'd, so it never
 * keeps the process up. Returns a stop function.
 */
export function keepOwnerHandoffFresh(
  runtime: OwnerHandoffRuntime,
  env: Record<string, string | undefined> = process.env,
  everyMs = RENEW_EVERY_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      if (
        !existsSync(join(runtime.applicationStateRoot(), 'onboarding.json'))
      ) {
        clearInterval(timer);
        return;
      }
    } catch {
      clearInterval(timer);
      return;
    }
    void ensureOwnerHandoff(runtime, env);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function savedUrl(handoff: string): string | null {
  try {
    const value = JSON.parse(readFileSync(handoff, 'utf8')) as {
      url?: unknown;
    };
    return typeof value.url === 'string' ? value.url : null;
  } catch {
    return null;
  }
}

function writePrivate(destination: string, contents: string): void {
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
