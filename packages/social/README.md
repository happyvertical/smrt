# @happyvertical/smrt-social

Social media account management for multi-platform publishing in the SMRT ecosystem. Manages OAuth connections, post scheduling, and analytics tracking across YouTube, Threads, X (Twitter), and Bluesky.

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
});
await state.save();
// On callback: state.verifyState(callbackState), then exchange code for tokens
```

## API

### Models

| Export | Description |
|--------|------------|
| `SocialAccount` | Connected platform account with OAuth credentials and publishing settings |
| `SocialPost` | Scheduled or published post with analytics tracking |
| `OAuthState` | Temporary OAuth flow state with CSRF protection and PKCE support |

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

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-content` -- content models
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-video` -- video content references
