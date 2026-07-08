import Foundation
import SmrtMobile

/// Opens smrt-mobile's durable `SmrtMobileDatabase` (write-queue + pack store) on
/// SQLDelight's `NativeSqliteDriver`, via the framework-exported `SmrtMobileIos`
/// factory (Swift cannot construct the Kotlin/Native driver itself — see the
/// factory's KDoc). Mirrors `AndroidSqlDriverFactory`'s contract.
///
/// **One database per app** — build it once at startup and share the
/// `DurableWriteQueue` / `DurableOfflinePackStore` instances constructed on it.
public enum NativeSqlDriverFactory {
    public static let defaultDatabaseName = "smrt_mobile.db"

    public static func createDatabase(name: String = defaultDatabaseName) -> SmrtMobileDatabase {
        SmrtMobileIos.shared.createDatabase(name: name)
    }
}
