/**
 * Reading a compose declaration at an exact commit. Network and YAML parsing
 * live here, outside the browser-safe `./deployment` entry, so that what is
 * validated is exactly what CI built: GitHub's contents API with
 * `ref=<commit>`, never a branch.
 *
 * Errors are {@link ComposeDeclarationReadError}s whose message names what
 * failed and never contains the token, a response body or file contents.
 */

import { parse } from 'yaml';

/** Compose file names read, in order, when the caller names none. */
export const COMPOSE_DECLARATION_PATHS = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
] as const;

/** Anchors and aliases a document may use. The contract needs none; this caps expansion attacks. */
export const COMPOSE_MAX_ALIAS_COUNT = 50;
/** Largest compose file read, in characters. */
export const COMPOSE_MAX_SOURCE_LENGTH = 1_048_576;

export type ComposeDeclarationReadErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'fetch-failed'
  | 'too-large'
  | 'invalid-yaml';

export class ComposeDeclarationReadError extends Error {
  constructor(
    readonly code: ComposeDeclarationReadErrorCode,
    message: string,
    /** The HTTP status, when the failure was a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ComposeDeclarationReadError';
  }
}

/**
 * Parse compose YAML for `validateComposeDeployment`: merge keys are not
 * expanded (the validator refuses `<<`), aliases are capped, and a parse
 * failure carries only a line number, never a snippet of the file.
 */
export function parseComposeDocument(text: string): unknown {
  if (text.length > COMPOSE_MAX_SOURCE_LENGTH) {
    throw new ComposeDeclarationReadError(
      'too-large',
      'The compose file is too large to read.',
    );
  }
  try {
    return parse(text, {
      maxAliasCount: COMPOSE_MAX_ALIAS_COUNT,
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    const line = (error as { linePos?: Array<{ line?: number }> }).linePos?.[0]
      ?.line;
    throw new ComposeDeclarationReadError(
      'invalid-yaml',
      `The compose file is not valid YAML${typeof line === 'number' ? ` (line ${line})` : ''}.`,
    );
  }
}

export interface GitHubComposeSourceOptions {
  owner: string;
  repo: string;
  /** The exact commit, 7 to 64 hex digits. A branch or tag name is refused. */
  commit: string;
  /** A GitHub token that can read the repository's contents. Never logged or echoed. */
  token: string;
  fetch?: typeof fetch;
  /** Paths tried in order. Defaults to {@link COMPOSE_DECLARATION_PATHS}. */
  paths?: readonly string[];
  /** Defaults to `https://api.github.com`. */
  apiBase?: string;
}

export interface GitHubComposeDeclaration {
  /** The path the file was found at. */
  path: string;
  /** The parsed document, ready for `validateComposeDeployment`. */
  document: unknown;
}

const OWNER = /^[A-Za-z0-9]([-A-Za-z0-9]{0,38})$|^[A-Za-z0-9]$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;

function usablePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/**
 * Read and parse the compose declaration at `commit`. Resolves with the first
 * of `paths` that exists; rejects with `not-found` when none does.
 */
export async function readGitHubComposeDeclaration(
  options: GitHubComposeSourceOptions,
): Promise<GitHubComposeDeclaration> {
  const paths = options.paths ?? COMPOSE_DECLARATION_PATHS;
  if (
    !OWNER.test(options.owner) ||
    !REPO.test(options.repo) ||
    options.repo === '.' ||
    options.repo === '..' ||
    !COMMIT.test(options.commit) ||
    paths.length === 0 ||
    !paths.every(usablePath) ||
    typeof options.token !== 'string' ||
    options.token === ''
  ) {
    throw new ComposeDeclarationReadError(
      'invalid-request',
      'The repository, commit, token or declaration path is not valid.',
    );
  }
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? 'https://api.github.com').replace(
    /\/+$/,
    '',
  );

  for (const path of paths) {
    const url = `${base}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(options.commit)}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {
          accept: 'application/vnd.github.raw+json',
          authorization: `Bearer ${options.token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      // The underlying error is dropped: it can name the request.
      throw new ComposeDeclarationReadError(
        'fetch-failed',
        'The compose declaration could not be fetched.',
      );
    }
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new ComposeDeclarationReadError(
        'fetch-failed',
        `The compose declaration could not be fetched (${response.status}).`,
        response.status,
      );
    }
    return { path, document: parseComposeDocument(await response.text()) };
  }
  throw new ComposeDeclarationReadError(
    'not-found',
    'There is no compose declaration at that commit.',
    404,
  );
}
