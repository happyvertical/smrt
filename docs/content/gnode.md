# @happyvertical/smrt-gnode

SMRT federation library for building federated local knowledge bases (gnodes).

## Overview

Gnodes are **federated local knowledge bases** that transform government documents into accessible, multi-modal knowledge. This package provides the federation utilities and protocols needed to enable P2P discovery and cross-gnode communication.

## Installation

```bash
pnpm add @happyvertical/smrt-gnode
```

## Usage

```typescript
import { Federation, WebFingerProtocol } from '@happyvertical/smrt-gnode';

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
- **SMRT Integration**: Built on @happyvertical/smrt-core for seamless object federation

## Documentation

See the [smrt-gnode README](./packages/gnode.md) for the current package reference.

## Related Packages

- [@happyvertical/smrt-core](./packages/core.md) - Core SMRT framework
- [@happyvertical/sql](https://github.com/happyvertical/sdk/tree/main/packages/sql) - Database abstraction layer

## License

TBD (likely MIT)
