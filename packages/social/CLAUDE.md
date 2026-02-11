# @happyvertical/smrt-social

Social media account management with OAuth integration and post scheduling. Supports YouTube, Instagram, TikTok, Facebook, Twitter/X, LinkedIn, and Bluesky.

## Architecture

```
src/
  index.ts              # Export barrel
  social-account.ts     # Social account model with OAuth tokens
  social-post.ts        # Social post model with scheduling
  oauth-state.ts        # OAuth state for CSRF protection and PKCE
  types/                # Platform types, post status
```

## Key Models

- `SocialAccount` — Platform account: accessToken, refreshToken, tokenExpiry, platformUserId, platformUsername
- `SocialPost` — Post record: content, mediaUrls, scheduledAt, publishedAt, platformPostId
- `OAuthState` — Temporary OAuth flow state with CSRF token and PKCE code verifier

## Key Patterns

- **Platform support**: youtube, instagram, tiktok, facebook, twitter, linkedin, bluesky
- **OAuth security**: OAuthState stores CSRF tokens and PKCE code verifiers with expiry (10 min default)
- **Token management**: Access/refresh token storage with expiry tracking
- **Post scheduling**: Posts can be scheduled for future publishing
- **STI**: OAuthState uses `tableStrategy: 'sti'`
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
