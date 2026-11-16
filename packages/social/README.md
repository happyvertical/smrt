# @happyvertical/smrt-social

Social media account management for multi-platform publishing in the s-m-r-t ecosystem. Manages OAuth connections, post scheduling, and analytics tracking across YouTube, Threads, X (Twitter), and Bluesky.

## Installation

```bash
pnpm add @happyvertical/smrt-social
```

## Usage

```typescript
import { SocialAccount, SocialPost, OAuthState } from '@happyvertical/smrt-social';

// Connect a social account
const account = new SocialAccount({
  name: 'Bentley News YouTube',
  platform: 'youtube',
  platformUsername: 'Bentley News',
  accessToken: 'encrypted-token',
  refreshToken: 'encrypted-refresh',
  tokenExpiresAt: new Date('2026-06-01'),
  defaultHashtags: ['news', 'local'],
  linkBehavior: 'description',
});
await account.save();

// Check readiness before publishing (active + connected + token present + not expired)
if (account.isReady) {
  const post = new SocialPost({
    socialAccountId: account.id,
    title: 'Breaking News from Bentley',
    description: 'Latest updates from the town council meeting.',
    hashtags: ['news', 'local', 'bentley'],
    linkUrl: 'https://example.com/article',
    scheduledAt: new Date('2026-03-05T18:00:00Z'),
    status: 'scheduled',
  });
  await post.save();
}

// OAuth flow: create state, redirect user, verify callback
const state = new OAuthState({
  platform: 'youtube',
  state: OAuthState.generateState(),
  codeVerifier: OAuthState.generateCodeVerifier(),
  redirectUri: 'https://app.example.com/oauth/callback',
  scopes: ['youtube.upload', 'youtube.readonly'],
  createdByUserId: currentUser.id, // reject a different user on callback
  returnTo: '/settings/social', // host-validated same-origin path
});
await state.save();
// On callback: state.verifyState(callbackState), check the user, then
// `await states.consume(state)` (false = already used) before exchanging the code
```

## Connecting accounts (OAuth)

`@happyvertical/smrt-social/connect` owns the connect flow so hosts mount two
routes and write no platform code. X is the first provider (OAuth 2.0
authorization code with PKCE, confidential client); register more with
`registerSocialConnectProvider`.

```typescript
import {
  completeSocialConnect,
  startSocialConnect,
} from '@happyvertical/smrt-social/connect';

// GET /connect/x  (host has authorized the caller and set the tenant)
const { authorizeUrl } = await startSocialConnect({
  db,
  platform: 'x',
  tenantId,
  redirectUri: 'https://app.example.com/social/callback/x',
});
// redirect to authorizeUrl

// GET /callback/x
const { account } = await completeSocialConnect({
  db,
  platform: 'x',
  tenantId,
  redirectUri: 'https://app.example.com/social/callback/x',
  query: { code, state, error },
});
```

Client credentials come from the provider's env names (X: `X_CLIENT_ID`,
`X_CLIENT_SECRET`, falling back to `TWITTER_CLIENT_ID`/`TWITTER_CLIENT_SECRET`) or the `client` option. Tokens are stored through
`SocialAccount.setCredentials` (smrt-secrets, per tenant) as a JSON payload
including `expiresAt`; nothing is written to the plain token columns or logs.
The state is single-use, tenant-bound, and checked against the registered
redirect URI. New accounts start in the platform's default publish mode
(`dry_run` for X); a reconnect updates the same account and never widens its
mode. Failures throw `SocialConnectError` with a safe, user-showable message.
No role checks live in the package. Register the same `redirectUri` with the
platform. YouTube, Facebook Pages and Threads providers are not built yet.

## API

### Models

| Export | Description |
|--------|------------|
| `SocialAccount` | Connected platform account with OAuth credentials and publishing settings |
| `SocialPost` | Scheduled or published post with analytics tracking; `createdByUserId` records the poster |
| `OAuthState` | Temporary OAuth flow state with CSRF protection and PKCE support; `createdByUserId` and `returnTo` bind it to its initiator and return page |

### Types

| Export | Description |
|--------|------------|
| `SocialPlatformType` | Platform identifier: `youtube`, `threads`, `x`, `bluesky` |
| `AccountStatus` | Connection status: `connected`, `expired`, `error` |
| `PostStatus` | Lifecycle status: `draft`, `scheduled`, `publishing`, `published`, `failed` |
| `LinkBehavior` | Link handling strategy: `description`, `reply`, `none` |
| `PostAnalytics` | Engagement metrics: views, likes, comments, shares, clicks |
| `SocialAccountOptions` | Account creation options |
| `SocialPostOptions` | Post creation options |
| `OAuthStateOptions` | OAuth state creation options |

### Key Computed Properties

- `SocialAccount.isReady` -- gate check: active + connected + token present + not expired
- `SocialAccount.isTokenExpired` -- checks with 5-minute buffer before actual expiry
- `SocialPost.isEditable` -- true when draft or failed
- `SocialPost.fullText` -- description + formatted hashtags
- `OAuthState.isValid` -- not expired and state token present
- `OAuthState.verifyState(callback)` -- CSRF verification for OAuth callbacks
- `OAuthState.generateCodeChallenge(verifier)` -- PKCE S256 challenge generation
- `OAuthStateCollection.consume(state)` -- single-use consumption; `false` when another caller consumed it first

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-content` -- content models
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-video` -- video content references
