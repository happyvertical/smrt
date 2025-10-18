class Federation {
  async discoverPeers() {
    return [];
  }
  async exchangePeers(_peer) {
    return [];
  }
}
class WebFingerProtocol {
  static async discover(_domain) {
    return null;
  }
}
class PeerExchangeProtocol {
  static async exchange(_peerUrl) {
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
