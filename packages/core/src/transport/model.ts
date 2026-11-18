/**
 * Transport kernel: model identity (#5158). Owned by K2; strict identity is
 * switched on here by F7 and nowhere else.
 */
import type { SmrtObjectConstructor } from '../registry/types.js';
import { notImplemented } from './not-implemented.js';
import type { Surface, TransportModel, TransportProfile } from './types.js';

/**
 * Resolve a model reference to the one registration it names.
 *
 * Contract:
 * - A constructor resolves through the constructor index, to the class in
 *   effect for it (a same-named app replacement wins).
 * - A qualified name resolves to that registration or a declared alias, never
 *   to a simple-name guess.
 * - A simple name owned by two packages throws `CONFIG_AMBIGUOUS_CLASS`; it is
 *   never resolved to the first match.
 * - Awaits `ObjectRegistry.ensureManifestLoaded()` first, so a lazily
 *   activated class is described from its real fields or not at all.
 * - A collection class resolves to the model it is a collection of.
 * - A registration whose generated-field validation failed rethrows that
 *   error.
 * - One descriptor per model, surface and profile, memoised per registry
 *   generation. No other state.
 *
 * @throws When the reference is unknown, ambiguous or failed registration.
 */
export function resolveTransportModel(
  _ref: string | SmrtObjectConstructor,
  _surface: Surface,
  _profile?: Partial<TransportProfile>,
): Promise<TransportModel> {
  return notImplemented('resolveTransportModel', 'K2');
}

/**
 * Resolve a route or sync segment to the model that owns it.
 *
 * Contract:
 * - Matches the canonical `collection` value verbatim; no re-pluralising.
 * - An STI family shares a segment: the base that declares it owns it.
 * - Framework base classes never own a segment.
 * - Two unrelated owners is an error, not a first match.
 * - `null` when nothing owns the segment.
 * - While `profile.lookup` is present, resolves exactly as that transport does
 *   today (first registry match).
 */
export function resolveCollectionSegment(
  _segment: string,
  _surface: Surface,
  _profile?: Partial<TransportProfile>,
): Promise<TransportModel | null> {
  return notImplemented('resolveCollectionSegment', 'K2');
}
