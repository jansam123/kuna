import Foundation
import JavaScriptCore

/// Kuna's shared TypeScript logic (ios/bridge.ts), run in JavaScriptCore: one source for both apps.
/// Everything crosses as strings; calls are one at a time.
public final class Shared: @unchecked Sendable {
  /// The one the app uses. A build without the bundle stops here, with what to run.
  public static let main: Shared = {
    do { return try Shared() } catch { fatalError(error.localizedDescription) }
  }()

  private let kuna: JSValue
  private let lock = NSLock()
  /// the helper script installed on hosts, and its version
  public let script: String
  public let version: String

  public init() throws {
    guard let url = Bundle.module.url(forResource: "kuna-shared", withExtension: "js"),
      let context = JSContext()
    else { throw KunaError("The app's shared logic is missing from the build. Run `npm run ios:bundle`.") }
    context.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
    guard let kuna = context.objectForKeyedSubscript("Kuna"), kuna.isObject else {
      throw KunaError("The app's shared logic failed to load: \(context.exception?.toString() ?? "no Kuna object")")
    }
    self.kuna = kuna
    script = kuna.objectForKeyedSubscript("script").toString()
    version = kuna.objectForKeyedSubscript("version").toString()
  }

  /// Call a function of the bridge; what it throws comes back as a `KunaError` with its message.
  @discardableResult
  public func call(_ name: String, _ args: [Any] = []) throws -> String {
    lock.lock()
    defer { lock.unlock() }
    let context = kuna.context!
    context.exception = nil
    let value = kuna.invokeMethod(name, withArguments: args)
    if let exception = context.exception {
      context.exception = nil
      let message = exception.objectForKeyedSubscript("message")?.toString() ?? exception.toString() ?? "unknown error"
      throw KunaError(message)
    }
    guard let value, !value.isUndefined, !value.isNull else { return "" }
    return value.isBoolean ? (value.toBool() ? "true" : "false") : value.toString()
  }

  /// The same, with its JSON answer decoded.
  public func decode<T: Decodable>(_ type: T.Type, _ name: String, _ args: [Any] = []) throws -> T {
    lock.lock()
    let context = kuna.context!
    context.exception = nil
    let value = kuna.invokeMethod(name, withArguments: args)
    let exception = context.exception
    context.exception = nil
    let text = value?.toString() ?? "null"
    lock.unlock()
    if let exception { throw KunaError(exception.objectForKeyedSubscript("message")?.toString() ?? "\(exception)") }
    return try JSONDecoder().decode(type, from: Data(text.utf8))
  }

  /// One watch frame as agents (their raw JSON too, for `tree`); `offset` is the host's clock minus the phone's.
  public func agents(host: String, lines: [String], now: Int, offset: Int) throws -> [Agent] {
    do {
      return try decode([Agent].self, "agents", [host, lines, now, offset])
    } catch {
      throw KunaError("Could not read the host's report: \(error.localizedDescription)")
    }
  }
}

public struct KunaError: LocalizedError, Sendable {
  public let message: String
  /// trying the same thing again cannot help (a refused sign-in, an untrusted host key): the user has to act
  public let final: Bool
  public init(_ message: String, final: Bool = false) {
    self.message = message
    self.final = final
  }
  public var errorDescription: String? { message }
}

public func json<T: Encodable>(_ value: T) -> String {
  String(decoding: (try? JSONEncoder().encode(value)) ?? Data("null".utf8), as: UTF8.self)
}
