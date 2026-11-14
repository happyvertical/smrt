// Support for launch-smoke.mjs that must work from the published
// @happyvertical/smrt-desktop package, where the repository's CLI and Vitest
// sources do not exist.
//
// `redactSecrets` and `boundedTail` mirror packages/cli/src/app/errors.ts. They
// are copied (not imported) because a published wrapper has nothing to import
// them from; launch-smoke.test.mjs asserts equal output on a corpus so the
// copy cannot drift silently. Node built-ins only.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REDACTED = '[redacted]';
const MIN_REDACTED_VALUE_LENGTH = 8;
const SECRET_ENVIRONMENT_NAME =
  /(?:^|_)(?:DATABASE_URL|URL|DSN|TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const URL_USERINFO =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]*(?::[^\s/@'"]*)?)@/dgi;
const QUERY_CREDENTIAL =
  /([?&;](?:token|password|secret|key|access_token|launch)=)([^&\s"'<>]+)/dgi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/dg;
const BEARER_ANY_LENGTH = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/dg;

function structuralSpans(text, strict) {
  const spans = [];
  for (const pattern of [
    URL_USERINFO,
    QUERY_CREDENTIAL,
    strict ? BEARER_ANY_LENGTH : BEARER,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const span = match.indices?.[2];
      if (span && (span[1] > span[0] || pattern === URL_USERINFO)) {
        spans.push([span[0], span[1]]);
      }
    }
  }
  return spans;
}

function literalSpans(text, values, opaque) {
  const spans = [];
  for (const value of values) {
    for (
      let index = text.indexOf(value);
      index !== -1;
      index = text.indexOf(value, index + 1)
    ) {
      const end = index + value.length;
      if (opaque.some(([start, stop]) => index >= start && end <= stop)) {
        continue;
      }
      spans.push([index, end]);
    }
  }
  return spans;
}

function markerSpans(text) {
  return literalSpans(text, [REDACTED], []);
}

function maskSpans(text, spans) {
  if (spans.length === 0) return text;
  spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let result = '';
  let cursor = 0;
  let [start, end] = spans[0];
  const flush = () => {
    result += text.slice(cursor, start) + REDACTED;
    cursor = end;
  };
  for (const [nextStart, nextEnd] of spans.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
      continue;
    }
    flush();
    [start, end] = [nextStart, nextEnd];
  }
  flush();
  return result + text.slice(cursor);
}

/** Remove secret material from an operator-facing message. */
export function redactSecrets(message, environment = process.env, options = {}) {
  const strict = options.strict === true;
  const minimumLength = strict ? 1 : MIN_REDACTED_VALUE_LENGTH;
  const secretValues = Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value.length >= minimumLength &&
        SECRET_ENVIRONMENT_NAME.test(name),
    )
    .map(([, value]) => value);
  const markers = markerSpans(message);
  const masked = maskSpans(message, [
    ...markers,
    ...structuralSpans(message, strict),
    ...literalSpans(message, secretValues, markers),
  ]);
  return maskSpans(masked, [
    ...markerSpans(masked),
    ...structuralSpans(masked, strict),
  ]);
}

/** The last `maxBytes` of `text`, cut at a line boundary. */
export function boundedTail(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const tail = bytes.subarray(bytes.length - maxBytes).toString('utf8');
  let cut = tail.slice(tail.indexOf('\n') + 1);
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(1);
  return cut;
}

/**
 * Point HOME and the OS data and log locations at a throwaway directory for
 * this process (the wrapper derives its data and log directories from them),
 * and return a function that restores them and removes the directory. The
 * smoke never reads or writes the real user profile.
 */
export function installIsolatedHome() {
  const base = realpathSync.native(tmpdir());
  const home = mkdtempSync(join(base, 'smrt-smoke-home-'));
  const environment = {
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  for (const directory of [environment.LOCALAPPDATA, environment.APPDATA]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const original = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener('exit', dispose);
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
  process.once('exit', dispose);
  return dispose;
}
