# @have/gnode

SMRT federation library for building federated local knowledge bases (gnodes).

## Overview

Gnodes are **federated local knowledge bases** that transform government documents into accessible, multi-modal knowledge. This package provides the federation utilities and protocols needed to enable P2P discovery and cross-gnode communication.

## Installation

```bash
pnpm add @have/gnode
```

## Usage

```typescript
import { Federation, WebFingerProtocol } from '@have/gnode';

// Configure federation
const federation = new Federation({
  enabled: true,
  discoverability: 'public',
  peers: ['https://example.gnode'],
  autodiscovery: true,
  peerExchange: true
});

// Discover peers
const peers = await federation.discoverPeers();

// Use WebFinger for discovery
const gnodeInfo = await WebFingerProtocol.discover('example.com');
```

## Features

- **P2P Discovery**: Automatic peer discovery via WebFinger and DNS
- **Peer Exchange**: Share peer lists between gnodes
- **Federation Protocols**: ActivityPub-inspired protocols for cross-gnode queries
- **SMRT Integration**: Built on @have/smrt for seamless object federation

## Documentation

### High-Level Concepts
- [Vision](./docs/vision.md) - Long-term roadmap for federated local knowledge
- [Principles](./docs/principles.md) - Core principles (Open, Federated, Transparent, etc.)

### Implementation Guides
See the [town template](../create-gnode/templates/town/) for complete implementation documentation:
- Architecture - Technical stack and system design
- Deployment - Infrastructure tiers and scaling
- Roadmap - 12-week implementation plan
- Standards - News standards, RSS, SEO

## Related Packages

- [@have/smrt](../smrt) - Core SMRT framework
- [@have/sql](../sql) - Database abstraction layer
- [@have/create-gnode](../create-gnode) - CLI generator for creating gnodes

## License

TBD (likely MIT)
