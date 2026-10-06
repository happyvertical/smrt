# @happyvertical/smrt-social

Social media account management with OAuth and post scheduling. Supports YouTube, Threads, X (Twitter), Bluesky.

## Models

- **SocialAccount** (STI): `platform`, `accessToken`/`refreshToken`, `tokenExpiresAt`, `status` (connected/expired/error), `linkBehavior` (description/reply/none). `isTokenExpired` checks with 5-min buffer. `isReady` gate checks active + connected + token present + not expired.
- **SocialPost**: `scheduledAt`, `publishedAt`, `status` (draft/scheduled/publishing/published/failed), `analytics` JSON (views/likes/comments/shares/clicks). `createdByUserId` (nullable `@crossPackageRef` to `smrt-users:User`, uuid on PostgreSQL) records the poster; pass it to `createDraft()` so a failed publish can be reported to that person. Agent/schedule posts leave it null; `recordPublishSuccess`/`Failure` never change it. Adding the column is additive: consumers run `db:migrate`.
- **OAuthState** (STI): CSRF token + PKCE `codeVerifier` with 10-min TTL. `createdByUserId` (nullable `@crossPackageRef` to `smrt-users:User`) binds the flow to its initiator and `returnTo` stores an opaque host path; a host with one fixed callback for every tenant must reject a different user and validate `returnTo` as same-origin. `OAuthStateCollection.consume(state)` is the single-use arbiter (revision-guarded delete; `false` when another caller already consumed it). Both columns are additive: consumers run `db:migrate`.

## Gotchas

- **Tokens not encrypted**: OAuth tokens stored as plaintext — TODO for smrt-secrets integration
- **No auto-publishing**: `scheduledAt` is metadata only — app must implement job runner to trigger publishing
- **Analytics manual**: `analytics` field must be updated by platform sync, not auto-populated
- **Platform enum hardcoded**: youtube/threads/x/bluesky — extending requires code changes
- **OAuthState TTL**: 10 minutes, app must clean up expired states
- **Optional tenancy** on all models
- **Relationship targets**: `SocialPost.socialAccountId` and
  `SocialPostAnalyticsSnapshot.socialPostId` are same-package `@foreignKey`
  columns; `SocialPost.videoContentId` is a `@crossPackageRef` to
  `@happyvertical/smrt-video:VideoContent` (no value import back into this
  package). They previously used `@foreignKey(() => X)`, whose target resolved
  to `''`, so none of them carried a relationship edge (#2379).
