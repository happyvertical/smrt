/**
 * Federation protocols for gnode discovery and communication
 */
export interface WebFingerResponse {
    subject: string;
    links: Array<{
        rel: string;
        type?: string;
        href: string;
    }>;
}
export declare class WebFingerProtocol {
    static discover(_domain: string): Promise<WebFingerResponse | null>;
}
export declare class PeerExchangeProtocol {
    static exchange(_peerUrl: string): Promise<string[]>;
}
//# sourceMappingURL=index.d.ts.map