/**
 * Federation utilities for gnode P2P discovery and communication
 */
export interface GnodePeer {
    url: string;
    name: string;
    discoveredAt: Date;
    lastSeen?: Date;
}
export interface FederationConfig {
    enabled: boolean;
    discoverability: 'public' | 'private';
    peers: string[];
    autodiscovery: boolean;
    peerExchange: boolean;
}
export declare class Federation {
    discoverPeers(): Promise<GnodePeer[]>;
    exchangePeers(_peer: GnodePeer): Promise<GnodePeer[]>;
}
//# sourceMappingURL=index.d.ts.map