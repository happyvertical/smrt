import Foundation
import SmrtMobile

/// Loads app-private evidence files when a durable multipart queue entry flushes.
/// Conversion to `KotlinByteArray` uses a native bulk copy in `SmrtMobileIos`.
public final class FoundationEvidenceByteSource: NSObject, EvidenceByteSource {
    private static let ioQueue = DispatchQueue(
        label: "com.happyvertical.smrt.evidence-byte-source",
        qos: .utility,
        attributes: .concurrent
    )

    private let baseDirectory: URL

    public init(baseDirectory: URL? = nil) {
        self.baseDirectory = baseDirectory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        super.init()
    }

    public func readBytes(asset: EvidenceAssetRef) async throws -> KotlinByteArray {
        let assetId = asset.assetId
        let localUri = asset.localUri
        let relativePath = asset.relativePath
        let baseDirectory = baseDirectory
        return try await withCheckedThrowingContinuation { continuation in
            Self.ioQueue.async {
                do {
                    let fileURL = try Self.fileURL(
                        assetId: assetId,
                        localUri: localUri,
                        relativePath: relativePath,
                        baseDirectory: baseDirectory
                    )
                    let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
                    continuation.resume(returning: SmrtMobileIos.shared.byteArray(data: data))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func fileURL(
        assetId: String,
        localUri: String,
        relativePath: String,
        baseDirectory: URL
    ) throws -> URL {
        if let url = URL(string: localUri), url.isFileURL {
            return url
        }
        if localUri.hasPrefix("/") {
            return URL(fileURLWithPath: localUri)
        }
        guard !relativePath.isEmpty else {
            throw FoundationEvidenceByteSourceError.missingFileLocation(assetId: assetId)
        }
        let canonicalBase = baseDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = canonicalBase
            .appendingPathComponent(relativePath)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        guard candidate.pathComponents.starts(with: canonicalBase.pathComponents) else {
            throw FoundationEvidenceByteSourceError.pathOutsideBaseDirectory(assetId: assetId)
        }
        return candidate
    }
}

public enum FoundationEvidenceByteSourceError: LocalizedError {
    case missingFileLocation(assetId: String)
    case pathOutsideBaseDirectory(assetId: String)

    public var errorDescription: String? {
        switch self {
        case let .missingFileLocation(assetId):
            return "Evidence asset \(assetId) has no readable local file location."
        case let .pathOutsideBaseDirectory(assetId):
            return "Evidence asset \(assetId) resolves outside the configured base directory."
        }
    }
}
