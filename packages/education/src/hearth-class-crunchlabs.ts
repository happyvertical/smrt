/**
 * Class CrunchLabs as a global catalog provider (SMRT #4616).
 *
 * Units are listed under Science, with the @ClassCrunchLabs YouTube course
 * playlists as previews. "Add to a course" (`addClassCrunchLabsUnit`) runs the
 * CrunchLabs import into the family's own course; the files come from
 * CrunchLabs' own downloads and from YouTube and are never hosted here.
 *
 * Until the operator has CrunchLabs' permission the provider is operator-only:
 * its records have `operator` visibility (see `CatalogPolicy`), seen only by the
 * families the host designated, with licence text "free curriculum, permission
 * pending". Making it public is one explicit switch, `publicListing: true`,
 * which only the operator sets in host configuration; it is off by default and
 * is never read from a request.
 */
import type {
  CatalogActor,
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncPage,
} from './catalog-contracts.js';
import type { CatalogPolicy } from './catalog-policy.js';
import type { CourseAuthoringActor } from './course-authoring-contracts.js';
import type {
  CourseBundleImportResult,
  CourseBundleImportService,
  ImportCourseBundleRequest,
} from './course-bundle-service.js';
import {
  buildClassCrunchLabsBundle,
  CLASS_CRUNCHLABS_PROVIDER_ID,
  CLASS_CRUNCHLABS_SUBJECT,
  type ClassCrunchLabsBuild,
  ClassCrunchLabsError,
  type ClassCrunchLabsFileSource,
  type ClassCrunchLabsPageCounter,
  type ClassCrunchLabsPlaylist,
  type ClassCrunchLabsPlaylistSource,
  classCrunchLabsKey,
} from './sources/class-crunchlabs.js';

export { CLASS_CRUNCHLABS_PROVIDER_ID };

/** The operator's switch for a public listing. Off until the operator turns it on. */
export const CLASS_CRUNCHLABS_PUBLIC_LISTING_DEFAULT = false;
export const CLASS_CRUNCHLABS_LICENSE_PENDING =
  'free curriculum, permission pending';
export const CLASS_CRUNCHLABS_LICENSE_FREE = 'free curriculum';
export const CLASS_CRUNCHLABS_LICENSE_IDENTIFIER =
  'class-crunchlabs-free-curriculum';

const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

export interface ClassCrunchLabsCatalogConfig {
  /** The channel's unit course playlists. Injected; the adapter never touches the network. */
  playlists: ClassCrunchLabsPlaylistSource;
  /**
   * The single switch that makes the provider public. Only the operator sets
   * it, from host configuration; only the literal `true` counts. Default off:
   * records are operator-only with licence "free curriculum, permission pending".
   */
  publicListing?: boolean;
}

/** The unit a playlist is about: its `unit`, else the title before any `|`, dash or parenthetical. */
export function classCrunchLabsUnitOfPlaylist(
  playlist: Pick<ClassCrunchLabsPlaylist, 'title' | 'unit'>,
): string {
  if (playlist.unit?.trim()) return playlist.unit.trim();
  return (
    playlist.title
      .split(/\s+[|–—-]\s+/)[0]
      ?.replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim() || playlist.title.trim()
  );
}

export const classCrunchLabsPlaylistUrl = (playlistId: string): string =>
  `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

/**
 * The privacy-enhanced embed URL previewing a listed unit's playlist, or null
 * when the record is not a Class CrunchLabs unit with a playlist.
 */
export function classCrunchLabsPreviewEmbedUrl(
  record: Pick<CatalogSourceRecord, 'providerId' | 'canonicalUrl'>,
): string | null {
  if (record.providerId !== CLASS_CRUNCHLABS_PROVIDER_ID) return null;
  try {
    const url = new URL(record.canonicalUrl);
    const id = url.searchParams.get('list');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.youtube.com' ||
      url.pathname !== '/playlist' ||
      !id ||
      !PLAYLIST_ID.test(id)
    )
      return null;
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${id}`;
  } catch {
    return null;
  }
}

async function digest(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function recordFor(
  playlist: ClassCrunchLabsPlaylist,
  publicListing: boolean,
): Promise<CatalogSourceRecord> {
  const unit = classCrunchLabsUnitOfPlaylist(playlist);
  const url = classCrunchLabsPlaylistUrl(playlist.id);
  const revision = (
    await digest(
      JSON.stringify([
        playlist.id,
        playlist.title,
        unit,
        playlist.items.map((i) => i.videoId),
        publicListing,
      ]),
    )
  ).slice(0, 24);
  return {
    providerId: CLASS_CRUNCHLABS_PROVIDER_ID,
    stableId: `unit:${classCrunchLabsKey(unit).replace(/ /g, '-')}`,
    revision: `r1-${revision}`,
    canonicalUrl: url,
    title: unit,
    suppliedDescription: `${playlist.items.length} videos in the Class CrunchLabs course playlist.`,
    author: 'Class CrunchLabs',
    subjects: [CLASS_CRUNCHLABS_SUBJECT],
    language: 'en',
    resourceType: 'curriculum-unit',
    // Files stay with CrunchLabs; nothing is acquirable from this listing.
    availableFormats: [],
    visibility: publicListing ? 'catalog' : 'operator',
    licenseEvidence: publicListing
      ? {
          state: 'verified',
          identifier: CLASS_CRUNCHLABS_LICENSE_IDENTIFIER,
          sourceUrl: url,
          attribution: 'Class CrunchLabs',
          exceptions: `${CLASS_CRUNCHLABS_LICENSE_FREE}; files stay with Class CrunchLabs and are never hosted here.`,
          permittedOperations: ['link'],
        }
      : {
          state: 'unknown',
          sourceUrl: url,
          attribution: 'Class CrunchLabs',
          exceptions: CLASS_CRUNCHLABS_LICENSE_PENDING,
          permittedOperations: [],
        },
  };
}

/**
 * Lists the channel's unit playlists as Science units. A snapshot feed: one
 * terminal page, no cursor. Visibility and licence follow `publicListing`;
 * flipping it changes every record's revision, so the next sync rewrites them.
 */
export function createClassCrunchLabsCatalogAdapter(
  config: ClassCrunchLabsCatalogConfig,
): CatalogSyncAdapter {
  return {
    async enumerate(input): Promise<CatalogSyncPage> {
      if (input.cursor)
        return {
          records: [],
          complete: false,
          exclusions: [
            {
              cursor: input.cursor,
              code: 'unsupported_provider_cursor',
              message:
                'The Class CrunchLabs listing is a snapshot without cursors.',
            },
          ],
        };
      const publicListing = config.publicListing === true;
      try {
        const playlists = await config.playlists.playlists();
        const records: CatalogSourceRecord[] = [];
        const seen = new Set<string>();
        for (const playlist of playlists) {
          if (!PLAYLIST_ID.test(playlist.id) || !playlist.title.trim())
            continue;
          const record = await recordFor(playlist, publicListing);
          if (seen.has(record.stableId)) continue;
          seen.add(record.stableId);
          records.push(record);
        }
        return { records, complete: true };
      } catch (error) {
        return {
          records: [],
          complete: false,
          paused: true,
          exclusions: [
            {
              code: 'provider_feed_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Class CrunchLabs playlists could not be read.',
            },
          ],
        };
      }
    },
  };
}

/**
 * The visibility the listing has right now, derived from the host's own
 * configuration (the same `publicListing` the adapter was built with), never
 * from a record or flag a caller supplies.
 */
export const classCrunchLabsListingVisibility = (
  config: Pick<ClassCrunchLabsCatalogConfig, 'publicListing'>,
): 'catalog' | 'operator' =>
  config.publicListing === true ? 'catalog' : 'operator';

/** True when the actor may see (and so add) the Class CrunchLabs listing. */
export function canAddClassCrunchLabsUnit(
  actor: CatalogActor,
  policy: CatalogPolicy,
  config: Pick<ClassCrunchLabsCatalogConfig, 'publicListing'>,
): boolean {
  return policy.canView(
    { visibility: classCrunchLabsListingVisibility(config) },
    actor,
  );
}

export interface AddClassCrunchLabsUnitRequest {
  service: CourseBundleImportService;
  /** The authenticated course author (the family's guardian). */
  actor: CourseAuthoringActor;
  /** The same identity as the catalog actor the listing was read with. */
  catalogActor: CatalogActor;
  /** The unit being added. Only its provider and title are used; visibility and licence are never taken from the caller. */
  record: Pick<CatalogSourceRecord, 'providerId' | 'title'>;
  /** The host's listing configuration (the switch the adapter was built with). */
  listing: Pick<ClassCrunchLabsCatalogConfig, 'publicListing'>;
  /** Host policy carrying the operator families. */
  policy: CatalogPolicy;
  /** The family's own download of the unit (folder or zip parts). */
  files: ClassCrunchLabsFileSource;
  playlists: ClassCrunchLabsPlaylistSource;
  pageCounter?: ClassCrunchLabsPageCounter;
  limits?: ImportCourseBundleRequest['limits'];
  onProgress?: ImportCourseBundleRequest['onProgress'];
  receiveMember?: ImportCourseBundleRequest['receiveMember'];
}
export interface AddClassCrunchLabsUnitResult {
  build: ClassCrunchLabsBuild;
  /** One import per bundle part, in order (one for a unit that fits one archive). */
  results: CourseBundleImportResult[];
  /** The first part's import. */
  result: CourseBundleImportResult;
}

/**
 * "Add to a course": re-checks that the actor may see this listing (an
 * operator-only listing is refused to everyone else, whatever the client
 * sends), reads the family's download into a manifest v2 bundle and imports it.
 * Store each part's accepted members, then `service.attachCourse` each
 * `build.parts[i].bundle` (any order): every part lands in one family course,
 * a `personal-use-copy` (`build.licenseKind`).
 */
export async function addClassCrunchLabsUnit(
  request: AddClassCrunchLabsUnitRequest,
): Promise<AddClassCrunchLabsUnitResult> {
  if (
    request.actor.tenantId !== request.catalogActor.tenantId ||
    request.actor.actorUserId !== request.catalogActor.actorUserId ||
    request.record.providerId !== CLASS_CRUNCHLABS_PROVIDER_ID ||
    !canAddClassCrunchLabsUnit(
      request.catalogActor,
      request.policy,
      request.listing,
    )
  )
    throw new ClassCrunchLabsError(
      'access_denied',
      'This Class CrunchLabs unit is not available to this family.',
    );
  const build = await buildClassCrunchLabsBundle({
    files: request.files,
    playlists: request.playlists,
    unit: request.record.title,
    ...(request.pageCounter ? { pageCounter: request.pageCounter } : {}),
  });
  const results: CourseBundleImportResult[] = [];
  for (const part of build.parts)
    results.push(
      await request.service.importBundle({
        ...request.actor,
        bundle: part.bundle,
        ...(request.limits ? { limits: request.limits } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.receiveMember
          ? { receiveMember: request.receiveMember }
          : {}),
      }),
    );
  return { build, results, result: results[0] as CourseBundleImportResult };
}
