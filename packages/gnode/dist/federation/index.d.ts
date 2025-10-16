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
    private config;
    constructor(config: FederationConfig);
    discoverPeers(): Promise<GnodePeer[]>;
    exchangePeers(peer: GnodePeer): Promise<GnodePeer[]>;
}
//# sourceMappingURL=index.d.ts.map