# @happyvertical/smrt-social

Social media account management for multi-platform publishing in the SMRT ecosystem. Manages OAuth connections, post scheduling, and analytics tracking across YouTube, Threads, X (Twitter), and Bluesky.

## Installation

```bash
pnpm add @happyvertical/smrt-social
```

## Usage

```typescript
import { SocialAccount, SocialPost, OAuthState } from '@happyvertical/smrt-social';

// The models are used via SmrtCollection patterns
// SocialAccount tracks connected platform accounts
// SocialPost manages scheduled/published posts
// OAuthState handles OAuth flow state
```

## API

### Models

| Export | Description |
|--------|------------|
| `SocialAccount` | Connected social media account with OAuth credentials |
| `SocialPost` | Scheduled or published social media post with analytics |
| `OAuthState` | OAuth flow state for account linking |

### Key Types

| Export | Description |
|--------|------------|
| `SocialPlatformType` | Platform identifier (youtube/threads/x/bluesky) |
| `AccountStatus` | Account connection status |
| `PostStatus` | Post lifecycle status |
| `LinkBehavior` | How links are handled per platform |
| `PostAnalytics` | Post performance metrics |

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-config` — configuration loading
- `@happyvertical/smrt-content` — content models
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- `@happyvertical/smrt-video` — video content
