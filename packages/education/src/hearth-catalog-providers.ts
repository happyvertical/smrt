import type {
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncCheckpoint,
  CatalogSyncPage,
} from './catalog-contracts.js';
import { parseIllustrativeMathematicsK5Index } from './sources/illustrative-mathematics-parser.js';
import { parseOerCommonsRssFeed } from './sources/oer-commons-rss-parser.js';

export type HearthCatalogProviderId =
  | 'illustrative-mathematics'
  | 'ck12'
  | 'oer-commons';

/**
 * A host-supplied integration for a provider-approved metadata feed. The
 * provider must approve the exact feed URL and credentials before it is used.
 * This deliberately does not guess a public endpoint or scrape course pages.
 */
export interface AuthorizedCatalogFeed {
  providerId: HearthCatalogProviderId;
  metadataFeedUrl: string;
  termsAccepted: true;
  enumerate(input: {
    cursor?: string;
    checkpoint: CatalogSyncCheckpoint;
  }): Promise<CatalogSyncPage>;
}

export interface ProviderMetadataResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type ProviderMetadataFetch = (
  url: string,
  options: {
    redirect: 'error';
    headers: { accept: string };
    signal?: AbortSignal;
  },
) => Promise<ProviderMetadataResponse>;

const DEFAULT_METADATA_TIMEOUT_MS = 10_000;

export interface PublicIllustrativeMathematicsK5Config {
  /** The official K-5 curriculum index; defaults to the published index. */
  indexUrl?: string;
  fetch: ProviderMetadataFetch;
  /** Bounds both the provider request and response-body read. */
  timeoutMs?: number;
}
export interface OerCommonsRssConfig {
  /** An ISKME/OER Commons-approved RSS or DC feed URL for an agreed collection. */
  feedUrl: string;
  fetch: ProviderMetadataFetch;
  /** Bounds both the provider request and response-body read. */
  timeoutMs?: number;
  /** Only set after the feed owner confirms this snapshot is terminal for its scope. */
  terminalSnapshot?: true;
}

export interface ProviderFeedRequirement {
  providerId: HearthCatalogProviderId;
  requirement: string;
}

export const providerFeedRequirements: readonly ProviderFeedRequirement[] = [
  {
    providerId: 'illustrative-mathematics',
    requirement:
      'A provider-approved, paginated metadata feed plus written catalog-harvesting permission.',
  },
  {
    providerId: 'ck12',
    requirement:
      'CK-12-approved catalog-feed access and credentials; ordinary web access is not an enumeration API.',
  },
  {
    providerId: 'oer-commons',
    requirement:
      'OER Commons-approved paginated metadata-feed access with each record’s publisher and license fields.',
  },
];

function unavailablePage(providerId: HearthCatalogProviderId): CatalogSyncPage {
  const requirement = providerFeedRequirements.find(
    (entry) => entry.providerId === providerId,
  );
  return {
    records: [],
    complete: false,
    paused: true,
    exclusions: [
      {
        code: 'provider_feed_not_configured',
        message: requirement?.requirement ?? 'Provider feed is not configured.',
      },
    ],
  };
}

function retryAfter(
  headers: ProviderMetadataResponse['headers'],
): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function httpsUrl(value: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} metadata URL is invalid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error(`${provider} metadata URL must be credential-free HTTPS.`);
  return url.toString();
}

async function fetchMetadata(
  fetch: ProviderMetadataFetch,
  url: string,
  accept: string,
  timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
): Promise<{ body: string; revision: string } | CatalogSyncPage> {
  const controller = new AbortController();
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Provider metadata request timed out.'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let response: ProviderMetadataResponse;
  try {
    response = await bounded(
      fetch(url, {
        redirect: 'error',
        headers: { accept },
        signal: controller.signal,
      }),
    );
  } catch (error) {
    return {
      records: [],
      complete: false,
      paused: true,
      exclusions: [
        {
          code: 'provider_feed_failed',
          message:
            error instanceof Error ? error.message : 'Metadata request failed.',
        },
      ],
    };
  }
  if (response.status === 429)
    return {
      records: [],
      complete: false,
      exclusions: [
        {
          code: 'provider_rate_limited',
          message: 'Provider metadata request was rate limited.',
          retryAfterMs: retryAfter(response.headers),
        },
      ],
    };
  if (!response.ok)
    return {
      records: [],
      complete: false,
      exclusions: [
        {
          code: 'provider_feed_failed',
          message: `Provider metadata request failed with HTTP ${response.status}.`,
        },
      ],
    };
  if (response.url !== url)
    return {
      records: [],
      complete: false,
      exclusions: [
        {
          code: 'unexpected_provider_redirect',
          message:
            'Provider metadata response URL did not match the configured URL.',
        },
      ],
    };
  let body: string;
  try {
    body = await bounded(response.text());
  } catch (error) {
    return {
      records: [],
      complete: false,
      paused: true,
      exclusions: [
        {
          code: 'provider_feed_failed',
          message:
            error instanceof Error ? error.message : 'Metadata read failed.',
        },
      ],
    };
  }
  if (new TextEncoder().encode(body).byteLength > 2_000_000)
    return {
      records: [],
      complete: false,
      exclusions: [
        {
          code: 'provider_metadata_oversized',
          message: 'Provider metadata response exceeds 2 MB.',
        },
      ],
    };
  const revision =
    response.headers.get('etag') ?? response.headers.get('last-modified');
  if (!revision)
    return {
      records: [],
      complete: false,
      exclusions: [
        {
          code: 'provider_revision_unavailable',
          message:
            'Provider metadata response supplied no ETag or Last-Modified revision.',
        },
      ],
    };
  return { body, revision };
}

function validRecord(
  providerId: HearthCatalogProviderId,
  record: CatalogSourceRecord,
): boolean {
  return (
    record.providerId === providerId &&
    record.stableId.trim().length > 0 &&
    record.revision.trim().length > 0 &&
    record.title.trim().length > 0 &&
    /^https:\/\//.test(record.canonicalUrl) &&
    typeof record.licenseEvidence.state === 'string'
  );
}

/**
 * Protects catalog state from optimistic completion and malformed provider
 * data. An unavailable feed stays explicitly incomplete and resumable.
 */
export class AuthorizedCatalogFeedAdapter implements CatalogSyncAdapter {
  constructor(
    private readonly providerId: HearthCatalogProviderId,
    private readonly feed?: AuthorizedCatalogFeed,
  ) {}

  async enumerate(input: {
    cursor?: string;
    checkpoint: CatalogSyncCheckpoint;
  }): Promise<CatalogSyncPage> {
    if (!this.feed) return unavailablePage(this.providerId);
    if (
      this.feed.providerId !== this.providerId ||
      this.feed.termsAccepted !== true ||
      !/^https:\/\//.test(this.feed.metadataFeedUrl)
    )
      return unavailablePage(this.providerId);

    try {
      const page = await this.feed.enumerate(input);
      const malformed = page.records.filter(
        (record) => !validRecord(this.providerId, record),
      );
      if (malformed.length) {
        return {
          records: page.records.filter((record) =>
            validRecord(this.providerId, record),
          ),
          complete: false,
          nextCursor: input.cursor,
          exclusions: [
            ...(page.exclusions ?? []),
            {
              cursor: input.cursor,
              code: 'invalid_provider_metadata',
              message: `${malformed.length} provider records lack required stable metadata or license evidence.`,
            },
          ],
        };
      }
      if (page.complete && page.nextCursor)
        return {
          records: page.records,
          complete: false,
          nextCursor: page.nextCursor,
          exclusions: [
            ...(page.exclusions ?? []),
            {
              cursor: input.cursor,
              code: 'contradictory_terminal_page',
              message:
                'A terminal provider page cannot also declare a next cursor.',
            },
          ],
        };
      return page;
    } catch (error) {
      return {
        records: [],
        complete: false,
        nextCursor: input.cursor,
        exclusions: [
          {
            cursor: input.cursor,
            code: 'provider_feed_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Provider metadata feed failed without an error message.',
          },
        ],
      };
    }
  }
}

export function createIllustrativeMathematicsAdapter(
  feed?: AuthorizedCatalogFeed,
): CatalogSyncAdapter {
  return new AuthorizedCatalogFeedAdapter('illustrative-mathematics', feed);
}

/** Enumerates only the public K-5 course index, never claims all IM coverage. */
export function createPublicIllustrativeMathematicsK5Adapter(
  config: PublicIllustrativeMathematicsK5Config,
): CatalogSyncAdapter {
  return {
    async enumerate(input) {
      if (input.cursor)
        return {
          records: [],
          complete: false,
          exclusions: [
            {
              cursor: input.cursor,
              code: 'unsupported_provider_cursor',
              message: 'The public IM K-5 index has no pagination cursor.',
            },
          ],
        };
      const url = httpsUrl(
        config.indexUrl ?? 'https://im.kendallhunt.com/k5/curriculum.html',
        'Illustrative Mathematics',
      );
      const result = await fetchMetadata(
        config.fetch,
        url,
        'text/html,application/xhtml+xml',
        config.timeoutMs,
      );
      if ('complete' in result) return result;
      try {
        return {
          records: parseIllustrativeMathematicsK5Index(
            result.body,
            result.revision,
            url,
          ),
          complete: false,
          exclusions: [
            {
              code: 'partial_provider_coverage',
              message:
                'The public IM K-5 index is not a complete IM catalog feed.',
            },
          ],
        };
      } catch (error) {
        return {
          records: [],
          complete: false,
          exclusions: [
            {
              code: 'provider_metadata_invalid',
              message:
                error instanceof Error
                  ? error.message
                  : 'IM metadata parsing failed.',
            },
          ],
        };
      }
    },
  };
}

export function createCk12Adapter(
  feed?: AuthorizedCatalogFeed,
): CatalogSyncAdapter {
  return new AuthorizedCatalogFeedAdapter('ck12', feed);
}

export function createOerCommonsAdapter(
  feed?: AuthorizedCatalogFeed,
): CatalogSyncAdapter {
  return new AuthorizedCatalogFeedAdapter('oer-commons', feed);
}

/** Parses an ISKME/OER Commons-approved RSS or Dublin Core collection feed. */
export function createOerCommonsRssAdapter(
  config: OerCommonsRssConfig,
): CatalogSyncAdapter {
  return {
    async enumerate(input) {
      if (input.cursor)
        return {
          records: [],
          complete: false,
          exclusions: [
            {
              cursor: input.cursor,
              code: 'unsupported_provider_cursor',
              message:
                'Configured OER RSS/DC feeds are snapshot feeds without cursors.',
            },
          ],
        };
      const url = httpsUrl(config.feedUrl, 'OER Commons');
      const result = await fetchMetadata(
        config.fetch,
        url,
        'application/rss+xml, application/xml, text/xml',
        config.timeoutMs,
      );
      if ('complete' in result) return result;
      try {
        return {
          records: parseOerCommonsRssFeed(result.body, result.revision),
          complete: config.terminalSnapshot === true,
          ...(config.terminalSnapshot === true
            ? {}
            : {
                exclusions: [
                  {
                    code: 'partial_provider_coverage',
                    message:
                      'Configured OER feed scope has not been confirmed as terminal.',
                  },
                ],
              }),
        };
      } catch (error) {
        return {
          records: [],
          complete: false,
          exclusions: [
            {
              code: 'provider_metadata_invalid',
              message:
                error instanceof Error
                  ? error.message
                  : 'OER RSS/DC parsing failed.',
            },
          ],
        };
      }
    },
  };
}
