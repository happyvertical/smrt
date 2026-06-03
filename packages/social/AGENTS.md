# @happyvertical/smrt-social

Social media account management with OAuth and post scheduling. Supports YouTube, Threads, X (Twitter), Bluesky.

## Models

- **SocialAccount** (STI): `platform`, `accessToken`/`refreshToken`, `tokenExpiresAt`, `status` (connected/expired/error), `linkBehavior` (description/reply/none). `isTokenExpired` checks with 5-min buffer. `isReady` gate checks active + connected + token present + not expired.
- **SocialPost**: `scheduledAt`, `publishedAt`, `status` (draft/scheduled/publishing/published/failed), `analytics` JSON (views/likes/comments/shares/clicks).
- **OAuthState** (STI): CSRF token + PKCE `codeVerifier` with 10-min TTL.

## Gotchas

- **Tokens not encrypted**: OAuth tokens stored as plaintext — TODO for smrt-secrets integration
- **No auto-publishing**: `scheduledAt` is metadata only — app must implement job runner to trigger publishing
- **Analytics manual**: `analytics` field must be updated by platform sync, not auto-populated
- **Platform enum hardcoded**: youtube/threads/x/bluesky — extending requires code changes
- **OAuthState TTL**: 10 minutes, app must clean up expired states
- **Optional tenancy** on all models
