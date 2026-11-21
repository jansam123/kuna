import Foundation
import JavaScriptCore

/// An agent as the watch stream reports it (`AgentRuntime` in src/shared/types.ts; the fields the phone shows).
public struct Agent: Codable, Identifiable, Hashable, Sendable {
  public var key: String
  public var kind: String
  public var host: String
  public var cwd: String
  public var status: String
  public var alive: Bool
  public var attnTs: Double
  public var activityTs: Double
  /// what to call it, as the Mac does (`titleOf` in src/shared/watch.ts)
  public var title: String
  public var detail: String?
  public var needs: String?
  public var tool: String?
  public var id: String { key }
}

/// Kuna's shared TypeScript logic (ios/bridge.ts), run in JavaScriptCore: one source for both apps.
public final class Shared: @unchecked Sendable {
  private let kuna: JSValue
  private let lock = NSLock()

  public init() throws {
    guard let url = Bundle.module.url(forResource: "kuna-shared", withExtension: "js"),
      let context = JSContext()
    else { throw KunaError("The app's shared logic is missing from the build. Run `npm run ios:bundle`.") }
    context.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
    guard let kuna = context.objectForKeyedSubscript("Kuna"), kuna.isObject else {
      throw KunaError("The app's shared logic failed to load: \(context.exception?.toString() ?? "no Kuna object")")
    }
    self.kuna = kuna
  }

  /// the helper script installed on hosts, and its version
  public var script: String { kuna.objectForKeyedSubscript("script").toString() }
  public var version: String { kuna.objectForKeyedSubscript("version").toString() }

  /// One watch frame as agents; `offset` is the host's clock minus the phone's, in seconds.
  public func agents(host: String, lines: [String], now: Int, offset: Int) throws -> [Agent] {
    lock.lock()
    defer { lock.unlock() }
    let context = kuna.context!
    context.exception = nil
    let json = kuna.invokeMethod("agents", withArguments: [host, lines, now, offset])
    if let exception = context.exception { throw KunaError("Could not read the host's report: \(exception)") }
    return try JSONDecoder().decode([Agent].self, from: Data((json?.toString() ?? "[]").utf8))
  }
}

public struct KunaError: LocalizedError, Sendable {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }
}
