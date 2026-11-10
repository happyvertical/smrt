/**
 * Lexical grammars shared by the desktop contracts. Every predicate is pure,
 * total over `unknown`, and never throws.
 */

const unpairedSurrogate = /\p{Surrogate}/u;
const portableSegment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const routeSegment = /^[A-Za-z0-9._~-]+$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bundleId = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const targetTriple = /^[a-z0-9_]+(?:-[a-z0-9_.]+){2,3}$/;
const channel = /^[a-z][a-z0-9-]{0,31}$/;
const envPrefix = /^[A-Z][A-Z0-9_]{0,31}$/;
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const loopbackOrigin = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const displayForbidden = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u;

/** ASCII-only case folding, so locale and Unicode folds never alias names. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** A string without NUL or unpaired UTF-16 surrogates. */
export function isValidText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    !unpairedSurrogate.test(value)
  );
}

/** One portable path segment: no separators, no trailing dot, no device. */
export function isPortableSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    portableSegment.test(value) &&
    !value.endsWith('.') &&
    !windowsDevice.test(value)
  );
}

/** A forward-slash-separated relative path of portable segments. */
export function isPortablePath(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every(isPortableSegment);
}

/** Shared grammar for loopback paths such as `healthRoute`. */
export function isLoopbackRoute(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (value === '/') return true;

  return value
    .slice(1, value.endsWith('/') ? -1 : undefined)
    .split('/')
    .every(
      (segment) =>
        routeSegment.test(segment) && segment !== '.' && segment !== '..',
    );
}

/** Lowercase kebab-case product identifier, at most 64 characters. */
export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && slug.test(value);
}

/**
 * Reverse-DNS application identifier (the Tauri `identifier`), at most 255
 * characters. It becomes a directory name, so a leading Windows device name
 * (`aux.example.app`) is rejected too.
 */
export function isBundleId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    bundleId.test(value) &&
    !windowsDevice.test(value)
  );
}

/** Semantic Version 2.0.0, at most 128 characters. */
export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && semver.test(value);
}

/** Rust target triple such as `aarch64-apple-darwin`. */
export function isTargetTriple(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && targetTriple.test(value)
  );
}

/** Release channel such as `stable` or `beta`. */
export function isChannel(value: unknown): value is string {
  return typeof value === 'string' && channel.test(value);
}

/** Environment variable prefix such as `SMRT_NOTES`. */
export function isEnvPrefix(value: unknown): value is string {
  return typeof value === 'string' && envPrefix.test(value);
}

/**
 * Human-readable single-line text: 1 to `maxLength` UTF-16 units, no control,
 * line-separator or bidirectional override characters, no surrounding space.
 */
export function isDisplayText(
  value: unknown,
  maxLength = 128,
): value is string {
  return (
    isValidText(value) &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !displayForbidden.test(value)
  );
}
