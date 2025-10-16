class Federation {
  constructor(config) {
    this.config = config;
  }
  async discoverPeers() {
    return [];
  }
  async exchangePeers(peer) {
    return [];
  }
}
class WebFingerProtocol {
  static async discover(domain) {
    return null;
  }
}
class PeerExchangeProtocol {
  static async exchange(peerUrl) {
    return [];
  }
}
const version = "0.1.0";
export {
  Federation,
  PeerExchangeProtocol,
  WebFingerProtocol,
  version
};
//# sourceMappingURL=index.js.map
