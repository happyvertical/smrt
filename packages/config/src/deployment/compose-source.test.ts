import { describe, expect, it, vi } from 'vitest';
import {
  type ComposeDeclarationReadError,
  parseComposeDocument,
  readGitHubComposeDeclaration,
} from './compose-source.js';

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TOKEN = 'ghs_supersecret';
const base = { owner: 'acme', repo: 'notes', commit: COMMIT, token: TOKEN };

function fetchOf(...responses: Array<Response | Error>) {
  const mock = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('', { status: 404 });
  });
  return mock;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ComposeDeclarationReadError;
  }
  throw new Error('expected a failure');
}

describe('readGitHubComposeDeclaration', () => {
  it('reads the file at the exact commit, raw, with the token as a bearer', async () => {
    const fetchImpl = fetchOf(new Response('services:\n  web: {}\n'));
    const result = await readGitHubComposeDeclaration({
      ...base,
      fetch: fetchImpl as never,
    });
    expect(result).toEqual({
      path: 'compose.yaml',
      document: { services: { web: {} } },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://api.github.com/repos/acme/notes/contents/compose.yaml?ref=${COMMIT}`,
    );
    expect(init.headers).toMatchObject({
      accept: 'application/vnd.github.raw+json',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('falls through missing files in order and then reports not-found', async () => {
    const found = fetchOf(
      new Response('', { status: 404 }),
      new Response('a: 1'),
    );
    expect(
      await readGitHubComposeDeclaration({ ...base, fetch: found as never }),
    ).toEqual({ path: 'compose.yml', document: { a: 1 } });

    const error = await failure(
      readGitHubComposeDeclaration({ ...base, fetch: fetchOf() as never }),
    );
    expect(error).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('never leaks the token or the body in a failure', async () => {
    const statusError = await failure(
      readGitHubComposeDeclaration({
        ...base,
        fetch: fetchOf(new Response(`echo ${TOKEN}`, { status: 403 })) as never,
      }),
    );
    expect(statusError).toMatchObject({ code: 'fetch-failed', status: 403 });
    expect(statusError.message).not.toContain(TOKEN);
    expect(statusError.message).not.toContain('echo');

    const networkError = await failure(
      readGitHubComposeDeclaration({
        ...base,
        fetch: fetchOf(new Error(`connect failed for ${TOKEN}`)) as never,
      }),
    );
    expect(networkError.code).toBe('fetch-failed');
    expect(networkError.message).not.toContain(TOKEN);
    expect(networkError.cause).toBeUndefined();
  });

  it('refuses a branch name, a traversal path and a missing token before fetching', async () => {
    const fetchImpl = fetchOf();
    for (const override of [
      { commit: 'main' },
      { owner: 'a/b' },
      { repo: '..' },
      { paths: ['../secrets.yaml'] },
      { paths: ['/etc/passwd'] },
      { token: '' },
    ]) {
      const error = await failure(
        readGitHubComposeDeclaration({
          ...base,
          ...override,
          fetch: fetchImpl as never,
        }),
      );
      expect(error.code).toBe('invalid-request');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseComposeDocument', () => {
  it('caps aliases so a document cannot expand without bound', () => {
    const anchors = Array.from({ length: 60 }, () => '- *a').join('\n');
    const error = (() => {
      try {
        parseComposeDocument(`a: &a x\nb:\n${anchors.replace(/^/gm, '  ')}\n`);
      } catch (caught) {
        return caught as ComposeDeclarationReadError;
      }
    })();
    expect(error?.code).toBe('invalid-yaml');
  });

  it('leaves merge keys unexpanded for the validator to refuse', () => {
    expect(parseComposeDocument('a: &a {x: 1}\nb:\n  <<: *a\n')).toEqual({
      a: { x: 1 },
      b: { '<<': { x: 1 } },
    });
  });

  it('reports a line, not the file contents, for bad YAML', () => {
    try {
      parseComposeDocument('ok: 1\nsecret: [unclosed');
    } catch (error) {
      expect((error as Error).message).toMatch(/not valid YAML/);
      expect((error as Error).message).not.toContain('secret');
      return;
    }
    throw new Error('expected a failure');
  });

  it('refuses an oversized file', () => {
    expect(() => parseComposeDocument('a'.repeat(1_048_577))).toThrow(
      /too large/,
    );
  });
});
