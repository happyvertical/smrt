import CryptoKit
import Foundation
import SmrtMobile

/// CryptoKit implementation of smrt-mobile's `Sha256Hasher` seam — pack and
/// evidence integrity pins are sha256 hex digests. Singleton, lowercase hex,
/// mirroring `AndroidSha256Hasher`.
public final class CryptoKitSha256Hasher: NSObject, Sha256Hasher {
    public static let shared = CryptoKitSha256Hasher()

    public func sha256Hex(bytes: KotlinByteArray) -> String {
        Self.sha256Hex(data: bytes.toData())
    }

    /// Pure, testable core. Known-answer vector:
    /// `sha256Hex("abc") == ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.
    static func sha256Hex(data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

extension KotlinByteArray {
    /// Copies a Kotlin `ByteArray` into Swift `Data`.
    func toData() -> Data {
        var data = Data(count: Int(size))
        if size > 0 {
            for index in 0..<size {
                data[Int(index)] = UInt8(bitPattern: get(index: index))
            }
        }
        return data
    }
}
