import { describe, expect, it, vi } from 'vitest';
import {
  credentialFromSecret,
  foldProjectSnapshots,
  OpenObserveReadError,
  OpenObserveStreamReader,
  PROJECT_OBSERVABILITY_FIXTURE_HITS,
  PROJECT_OBSERVABILITY_FIXTURE_RECORDS,
  parseProjectObservabilityRecord,
} from '../observability.js';

const FAKE_TOKEN = 'fake-placeholder-token-not-a-real-credential';
const ENDPOINT = 'https://openobserve.example.invalid/';

function reader(fetchImpl: unknown, extra = {}) {
  return new OpenObserveStreamReader({
    endpoint: ENDPOINT,
    credential: () => FAKE_TOKEN,
    fetch: fetchImpl as typeof fetch,
    now: () => new Date('2025-10-09T12:00:00Z'),
    ...extra,
  });
}

function okFetch(hits: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ hits }), { status: 200 }),
  );
}

function sentQuery(f: ReturnType<typeof okFetch>) {
  return JSON.parse(f.mock.calls[0][1]?.body as string).query;
}

describe('observability reader', () => {
  it('posts SQL with a microsecond window and auth header', async () => {
    const f = okFetch(PROJECT_OBSERVABILITY_FIXTURE_HITS);
    await reader(f).queryWindow();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://openobserve.example.invalid/api/default/_search');
    expect(init?.method).toBe('POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${FAKE_TOKEN}`);
    const q = sentQuery(f);
    expect(q.sql).toContain('FROM "project_observability"');
    expect(q.sql).toContain("record_kind = 'snapshot'");
    expect(q.sql).toContain('ORDER BY observed_at DESC');
    expect(q.end_time).toBe(Date.parse('2025-10-09T12:00:00Z') * 1000);
    expect(q.end_time - q.start_time).toBe(86_400_000 * 1000);
  });

  it('latest-per-key SQL is windowed server-side', async () => {
    const f = okFetch([]);
    await reader(f).latestPerProject({ projectIds: ['example-site'] });
    const sql = sentQuery(f).sql as string;
    expect(sql).toContain('PARTITION BY project, source, entity');
    expect(sql).toContain("project IN ('example-site')");
  });

  it('parses the collector long format per source and ignores others', () => {
    const recs = PROJECT_OBSERVABILITY_FIXTURE_RECORDS;
    expect(recs).toHaveLength(PROJECT_OBSERVABILITY_FIXTURE_HITS.length - 1);
    const matomo = recs.find(
      (r) => r.source === 'matomo' && r.visitors === 120,
    );
    expect(matomo).toMatchObject({ visits: 150, actions: 340, entity: '7' });
    const bifrost = recs.find(
      (r) => r.source === 'bifrost' && r.entity === 'vk-example',
    );
    expect(bifrost).toMatchObject({
      totalTokens: 45000,
      estimatedCostUsd: 2.75,
    });
    expect(parseProjectObservabilityRecord(null)).toBeNull();
    expect(
      parseProjectObservabilityRecord({
        project: 'a',
        source: 'codex',
        entity: 'x',
        observed_at: 1,
      }),
    ).toBeNull();
    expect(
      parseProjectObservabilityRecord({
        project: 'a',
        source: 'ci',
        entity: 'x',
      }),
    ).toBeNull();
    const ci = parseProjectObservabilityRecord({
      project: 'a',
      source: 'ci',
      entity: 'o/r',
      observed_at: '1000000',
      conclusion: 'success',
    });
    expect(ci).toMatchObject({ conclusion: 'success', runStatus: null });
  });

  it('folds the latest rows into per-project snapshots', async () => {
    const snaps = await reader(
      okFetch(PROJECT_OBSERVABILITY_FIXTURE_HITS),
    ).latestPerProject();
    expect(snaps.map((s) => s.projectId)).toEqual([
      'example-internal',
      'example-site',
    ]);
    const site = snaps[1];
    expect(site.summary).toMatchObject({
      visitors: 120,
      errorEvents: null,
      aiTotalTokens: 45000,
      aiEstimatedCostUsd: 2.75,
      workloadsDesired: 2,
      workloadsReady: 2,
      deploymentsReady: 1,
      deploymentsTotal: 1,
      latestCi: [
        { repository: 'example-org/example-site', conclusion: 'success' },
      ],
    });
    expect(site.sources.glitchtip?.status).toBe('error');
    expect(site.records.glitchtip).toEqual([]);
    expect(site.records.bifrost).toHaveLength(2);
    const internal = snaps[0];
    expect(internal.sources.matomo?.status).toBe('not_connected');
    expect(internal.summary.visitors).toBeNull();
    expect(internal.summary.workloadsReady).toBe(0);
  });

  it("drops entities missing from a source's latest poll", () => {
    const recs = PROJECT_OBSERVABILITY_FIXTURE_RECORDS.filter(
      (r) => r.project === 'example-site',
    );
    // Older-poll CI row for a repo no longer reported in the latest poll.
    const stale = parseProjectObservabilityRecord({
      project: 'example-site',
      source: 'ci',
      entity: 'example-org/gone',
      observed_at: 1_000_000,
      conclusion: 'success',
    });
    const [snap] = foldProjectSnapshots([...recs, stale!]);
    expect(snap.records.ci.map((c) => c.entity)).toEqual([
      'example-org/example-site',
    ]);
  });

  it('rejects injection in project ids', async () => {
    await expect(
      reader(okFetch([])).latestPerProject({ projectIds: ["x' OR '1'='1"] }),
    ).rejects.toThrow(OpenObserveReadError);
  });

  it('errors instead of silently truncating at the row cap', async () => {
    const f = okFetch(PROJECT_OBSERVABILITY_FIXTURE_HITS);
    await expect(
      reader(f, {
        maxRows: PROJECT_OBSERVABILITY_FIXTURE_HITS.length - 1,
      }).queryWindow(),
    ).rejects.toThrow(/cap/);
    // Exactly maxRows hits is complete, not truncated; one extra row is probed.
    const exact = okFetch(PROJECT_OBSERVABILITY_FIXTURE_HITS);
    await expect(
      reader(exact, {
        maxRows: PROJECT_OBSERVABILITY_FIXTURE_HITS.length,
      }).queryWindow(),
    ).resolves.toHaveLength(PROJECT_OBSERVABILITY_FIXTURE_HITS.length - 1);
    expect(sentQuery(exact).size).toBe(
      PROJECT_OBSERVABILITY_FIXTURE_HITS.length + 1,
    );
  });

  it('never leaks the credential in errors', async () => {
    const leaky = vi.fn(
      async () => new Response(`bad token ${FAKE_TOKEN}`, { status: 401 }),
    );
    const err = await reader(leaky)
      .queryWindow()
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenObserveReadError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(FAKE_TOKEN);

    const throwing = vi.fn(async () => {
      throw new Error(`boom ${FAKE_TOKEN}`);
    });
    const err2 = await reader(throwing)
      .queryWindow()
      .catch((e) => e);
    expect(err2).toBeInstanceOf(OpenObserveReadError);
    expect(String(err2.message)).not.toContain(FAKE_TOKEN);
  });

  it('resolves endpoint and credential at call time from a secret source', async () => {
    const retrieve = vi.fn(async (_name: string) => ({ value: FAKE_TOKEN }));
    const r = new OpenObserveStreamReader({
      endpoint: async () => ENDPOINT,
      credential: credentialFromSecret({ retrieve }, 'openobserve.read'),
      fetch: okFetch([]) as unknown as typeof fetch,
    });
    expect(retrieve).not.toHaveBeenCalled();
    await r.queryWindow();
    expect(retrieve).toHaveBeenCalledWith('openobserve.read');
  });

  it('rejects missing config, bad windows, bad names, and bad responses', async () => {
    const f = okFetch([]);
    await expect(
      reader(f, { credential: () => '' }).queryWindow(),
    ).rejects.toThrow(/configured/);
    await expect(
      reader(f).queryWindow({ start: new Date(2000), end: new Date(1000) }),
    ).rejects.toThrow(/precede/);
    await expect(
      reader(f).queryWindow({ start: new Date('nope') }),
    ).rejects.toThrow(/invalid date/);
    await expect(
      reader(f).latestPerProject({ end: new Date(Number.NaN) }),
    ).rejects.toThrow(/invalid date/);
    expect(
      () =>
        new OpenObserveStreamReader({
          endpoint: ENDPOINT,
          credential: () => FAKE_TOKEN,
          stream: 'a"; DROP',
        }),
    ).toThrow(OpenObserveReadError);
    const noHits = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(reader(noHits).queryWindow()).rejects.toThrow(/hits/);
  });

  it('refuses to run in a browser', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      await expect(reader(okFetch([])).queryWindow()).rejects.toThrow(
        /server-only/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
