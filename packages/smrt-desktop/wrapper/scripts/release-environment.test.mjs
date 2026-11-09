// Run with: node --test scripts/release-environment.test.mjs
// The GitHub API is replaced by fixtures shaped like real answers; no network
// and no token are involved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkEnvironment,
  main,
  makeGitHubApi,
} from './release-environment.mjs';

const REPO = 'happyvertical/smrt';
const NAME = 'desktop-release';
const BASE = `/repos/${REPO}/environments/${NAME}`;

const validEnvironment = (overrides = {}) => ({
  id: 1,
  name: NAME,
  can_admins_bypass: false,
  protection_rules: [
    {
      id: 10,
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'octo' } }],
    },
    { id: 11, type: 'branch_policy' },
  ],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  ...overrides,
});
const validPolicies = () => ({
  total_count: 1,
  branch_policies: [{ id: 5, name: 'main', type: 'branch' }],
});

/** A fixture API: path -> { status, body }; anything else is a 404. */
const fixtureApi = (table) => async (path) =>
  table[path] ?? { status: 404, body: { message: 'Not Found' } };

const valid = () => ({
  [BASE]: { status: 200, body: validEnvironment() },
  [`${BASE}/deployment-branch-policies`]: {
    status: 200,
    body: validPolicies(),
  },
});

const run = (table) =>
  checkEnvironment({ repo: REPO, environment: NAME, api: fixtureApi(table) });

const withEnvironment = (overrides) => ({
  ...valid(),
  [BASE]: { status: 200, body: validEnvironment(overrides) },
});
const withPolicies = (body) => ({
  ...valid(),
  [`${BASE}/deployment-branch-policies`]: { status: 200, body },
});

describe('checkEnvironment', () => {
  it('accepts a protected environment limited to main', async () => {
    assert.deepEqual(await run(valid()), []);
  });

  it('refuses a missing environment (404) and says the token may be the cause', async () => {
    const problems = await run({});
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not found, or the token cannot read it/);
    assert.match(problems[0], /actions: read/);
  });

  it('fails closed, naming the permission, when the token is refused', async () => {
    for (const status of [401, 403]) {
      const problems = await run({ [BASE]: { status, body: {} } });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /refused/);
      assert.match(problems[0], /actions: read/);
    }
  });

  it('fails closed on a server error, a bad body and a network failure', async () => {
    assert.equal((await run({ [BASE]: { status: 500, body: {} } })).length, 1);
    assert.equal((await run({ [BASE]: { status: 200, body: [] } })).length, 1);
    const problems = await checkEnvironment({
      repo: REPO,
      environment: NAME,
      api: async () => {
        throw new Error('ECONNRESET');
      },
    });
    assert.match(problems[0], /could not be reached/);
  });

  it('refuses an environment with no protection rules (the auto-created one)', async () => {
    const problems = await run(
      withEnvironment({
        can_admins_bypass: true,
        protection_rules: [],
        deployment_branch_policy: null,
      }),
    );
    assert.ok(problems.some((p) => /no required reviewers/.test(p)));
    assert.ok(problems.some((p) => /bypass/.test(p)));
    assert.ok(problems.some((p) => /deployment branches/.test(p)));
  });

  it('refuses a reviewers rule with nobody in it', async () => {
    const problems = await run(
      withEnvironment({
        protection_rules: [
          { type: 'required_reviewers', prevent_self_review: true, reviewers: [] },
        ],
      }),
    );
    assert.ok(problems.some((p) => /no required reviewers/.test(p)));
  });

  it('refuses self-review being allowed', async () => {
    for (const flag of [false, undefined]) {
      const problems = await run(
        withEnvironment({
          protection_rules: [
            {
              type: 'required_reviewers',
              prevent_self_review: flag,
              reviewers: [{ type: 'User' }],
            },
          ],
        }),
      );
      assert.ok(problems.some((p) => /Prevent self-review/.test(p)));
    }
  });

  it('refuses admins being able to bypass, or the field being absent', async () => {
    for (const value of [true, undefined]) {
      const problems = await run(withEnvironment({ can_admins_bypass: value }));
      assert.ok(problems.some((p) => /bypass/.test(p)));
    }
  });

  it('refuses any-branch deployment (no branch policy at all)', async () => {
    const problems = await run(
      withEnvironment({ deployment_branch_policy: null }),
    );
    assert.ok(problems.some((p) => /deployment branches/.test(p)));
  });

  it('refuses protected-branches-only and a mixed policy', async () => {
    for (const policy of [
      { protected_branches: true, custom_branch_policies: false },
      { protected_branches: true, custom_branch_policies: true },
      { protected_branches: false, custom_branch_policies: false },
    ]) {
      const problems = await run(
        withEnvironment({ deployment_branch_policy: policy }),
      );
      assert.ok(problems.some((p) => /deployment branches/.test(p)));
    }
  });

  it('refuses a tag pattern', async () => {
    const problems = await run(
      withPolicies({
        total_count: 1,
        branch_policies: [{ id: 6, name: 'v*', type: 'tag' }],
      }),
    );
    assert.ok(problems.some((p) => /exactly the branch main/.test(p)));
    // a tag named main is still a tag
    assert.ok(
      (
        await run(
          withPolicies({
            total_count: 1,
            branch_policies: [{ id: 6, name: 'main', type: 'tag' }],
          }),
        )
      ).length > 0,
    );
  });

  it('refuses extra branch patterns and wildcards', async () => {
    const extra = await run(
      withPolicies({
        total_count: 2,
        branch_policies: [
          { id: 5, name: 'main', type: 'branch' },
          { id: 7, name: 'release/*', type: 'branch' },
        ],
      }),
    );
    assert.ok(extra.some((p) => /exactly the branch main/.test(p)));
    for (const name of ['*', 'main*', 'ma*', 'master', 'refs/heads/main']) {
      const problems = await run(
        withPolicies({
          total_count: 1,
          branch_policies: [{ id: 8, name, type: 'branch' }],
        }),
      );
      assert.ok(problems.length > 0, name);
    }
  });

  it('refuses an empty or inconsistent policy list', async () => {
    assert.ok(
      (await run(withPolicies({ total_count: 0, branch_policies: [] }))).length > 0,
    );
    assert.ok(
      (
        await run(
          withPolicies({
            total_count: 5,
            branch_policies: [{ id: 5, name: 'main', type: 'branch' }],
          }),
        )
      ).length > 0,
    );
  });

  it('fails closed when the branch rules cannot be read', async () => {
    const table = valid();
    delete table[`${BASE}/deployment-branch-policies`];
    const problems = await run(table);
    assert.ok(problems.some((p) => /could not be read/.test(p)));
    // a 403 or 404 on this endpoint names the permission too
    for (const status of [403, 404]) {
      const refused = await run({
        ...valid(),
        [`${BASE}/deployment-branch-policies`]: { status, body: {} },
      });
      assert.ok(
        refused.some((p) => /could not be read/.test(p) && /actions: read/.test(p)),
        refused.join(' | '),
      );
    }
  });

  it('refuses names that are not plain', async () => {
    for (const [repo, environment] of [
      ['a/b c', NAME],
      [REPO, '../x'],
      [REPO, ''],
      [undefined, NAME],
    ]) {
      const problems = await checkEnvironment({
        repo,
        environment,
        api: fixtureApi(valid()),
      });
      assert.equal(problems.length, 1);
    }
  });
});

describe('makeGitHubApi', () => {
  it('sends the token as a bearer header and returns status and body', async () => {
    const seen = [];
    const api = makeGitHubApi({
      token: 'test-token-value',
      apiUrl: 'https://api.example.test',
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { status: 200, json: async () => ({ ok: true }) };
      },
    });
    assert.deepEqual(await api('/repos/a/b'), { status: 200, body: { ok: true } });
    assert.equal(seen[0].url, 'https://api.example.test/repos/a/b');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer test-token-value');
    assert.equal(seen[0].init.redirect, 'error');
  });

  it('reports a body that is not JSON as undefined', async () => {
    const api = makeGitHubApi({
      token: 'x',
      fetchImpl: async () => ({
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      }),
    });
    assert.deepEqual(await api('/x'), { status: 502, body: undefined });
  });
});

describe('main', () => {
  const go = async (argv, env, api) => {
    let text = '';
    const code = await main(argv, env, { stderr: (t) => (text += t), api });
    return { code, text };
  };
  const args = ['--repo', REPO, '--environment', NAME];

  it('is a usage error without the options', async () => {
    assert.equal((await go([], {})).code, 2);
    assert.equal((await go(['--repo', REPO], {})).code, 2);
    assert.equal((await go(['--bogus', 'x'], {})).code, 2);
  });

  it('passes for a protected environment', async () => {
    const { code, text } = await go(args, {}, fixtureApi(valid()));
    assert.equal(code, 0);
    assert.match(text, /passed/);
  });

  it('fails closed, with the README pointer, for an unprotected environment', async () => {
    const { code, text } = await go(
      args,
      {},
      fixtureApi(withEnvironment({ protection_rules: [] })),
    );
    assert.equal(code, 1);
    assert.match(text, /FAILED/);
    assert.match(text, /Owner setup/);
    assert.match(text, /owner mistake/);
  });

  it('fails closed without a token instead of skipping the check', async () => {
    const { code, text } = await go(args, {});
    assert.equal(code, 1);
    assert.match(text, /no GITHUB_TOKEN/);
    assert.match(text, /contents: read/);
  });
});
