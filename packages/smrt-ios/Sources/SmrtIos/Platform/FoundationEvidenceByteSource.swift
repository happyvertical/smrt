import Foundation
import SmrtMobile

/// Loads app-private evidence files when a durable multipart queue entry flushes.
/// Conversion to `KotlinByteArray` uses a native bulk copy in `SmrtMobileIos`.
public final class FoundationEvidenceByteSource: NSObject, EvidenceByteSource {
    private let baseDirectory: URL

    public init(baseDirectory: URL? = nil) {
        self.baseDirectory = baseDirectory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        super.init()
    }

    public func readBytes(asset: EvidenceAssetRef) async throws -> KotlinByteArray {
        let data = try Data(contentsOf: try fileURL(for: asset), options: .mappedIfSafe)
        return SmrtMobileIos.shared.byteArray(data: data)
    }

    private func fileURL(for asset: EvidenceAssetRef) throws -> URL {
        if let url = URL(string: asset.localUri), url.isFileURL {
            return url
        }
        if asset.localUri.hasPrefix("/") {
            return URL(fileURLWithPath: asset.localUri)
        }
        guard !asset.relativePath.isEmpty else {
            throw FoundationEvidenceByteSourceError.missingFileLocation(assetId: asset.assetId)
        }
        return baseDirectory.appendingPathComponent(asset.relativePath)
    }
}

public enum FoundationEvidenceByteSourceError: LocalizedError {
    case missingFileLocation(assetId: String)

    public var errorDescription: String? {
        switch self {
        case let .missingFileLocation(assetId):
            return "Evidence asset \(assetId) has no readable local file location."
        }
    }
}
