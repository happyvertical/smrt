# @happyvertical/smrt-gnode

Federation library for inter-gnode peer-to-peer discovery and communication.

**Status: stubs only -- not implemented. All methods return empty arrays or null.**

## Installation

```bash
pnpm add @happyvertical/smrt-gnode
```

## Intent

Gnodes are federated local knowledge bases. This package will provide the federation protocols needed for P2P discovery and cross-gnode communication. No SMRT models are present -- this is a library-stage package.

## Exports

### Classes

| Export | Status | Description |
|--------|--------|------------|
| `Federation` | Stub | Peer discovery and exchange. `discoverPeers()` and `exchangePeers()` return `[]` |
| `WebFingerProtocol` | Stub | `.well-known/gnode` discovery. `discover()` returns `null` |
| `PeerExchangeProtocol` | Stub | `/api/federation/peers` peer list exchange. `exchange()` returns `[]` |

### Types

| Export | Description |
|--------|------------|
| `GnodePeer` | Peer descriptor: `url`, `name`, `discoveredAt`, `lastSeen?` |
| `FederationConfig` | Config: `enabled`, `discoverability`, `peers`, `autodiscovery`, `peerExchange` |
| `WebFingerResponse` | WebFinger response: `subject`, `links[]` |

### Constants

| Export | Description |
|--------|------------|
| `version` | Package version string (`'0.1.0'`) |

## Planned Architecture

- WebFinger-based peer discovery via `GET /.well-known/gnode`
- Peer exchange protocol via `GET /api/federation/peers`
- ActivityPub-inspired cross-gnode queries

## Dependencies

None. Standalone stub package.
