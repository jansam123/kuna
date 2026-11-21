import Foundation
import KunaCore
import Observation

/// One hop: what `~/.ssh/config` calls HostName, Port and User.
public struct Hop: Codable, Equatable {
  public var address = ""
  public var port = 22
  public var user = ""
  var target: SSHTarget { SSHTarget(host: address.trimmingCharacters(in: .whitespaces), port: port, user: user.trimmingCharacters(in: .whitespaces)) }
  var filled: Bool { !target.host.isEmpty && !target.user.isEmpty }
  /// where its password is kept in the keychain
  var account: String { "password:\(target.user)@\(target.knownHostsName)" }
}

public struct SavedHost: Codable, Equatable {
  public var name = ""
  public var hop = Hop()
  public var usesJump = false
  public var jump = Hop()
  var title: String { name.isEmpty ? hop.address : name }
}

struct HostKeyQuestion: Identifiable {
  let id = UUID()
  let host: String
  let fingerprint: String
  let answer: (Bool) -> Void
}

@MainActor @Observable
public final class AppModel {
  enum Phase: Equatable {
    case idle
    case connecting
    case installing
    case ready(hostname: String, claude: Bool)
    case failed(String)
  }

  var host: SavedHost {
    didSet { UserDefaults.standard.set(try? JSONEncoder().encode(host), forKey: "host") }
  }
  private(set) var phase = Phase.idle
  private(set) var agents: [Agent] = []
  var question: HostKeyQuestion?
  private(set) var publicKey = ""

  private var task: Task<Void, Never>?
  /// why the last host key was refused, for the message
  private var refusal: String?

  public init() {
    host = UserDefaults.standard.data(forKey: "host").flatMap { try? JSONDecoder().decode(SavedHost.self, from: $0) } ?? SavedHost()
    publicKey = (try? DeviceKey.load()).map { openSSHPublicKey($0, comment: "kuna-iphone") } ?? ""
  }

  var connected: Bool {
    if case .ready = phase { true } else { false }
  }

  func password(_ hop: Hop) -> String {
    Keychain.get(hop.account).map { String(decoding: $0, as: UTF8.self) } ?? ""
  }

  func setPassword(_ hop: Hop, _ password: String) {
    Keychain.set(hop.account, Data(password.utf8))
  }

  /// Called when the app comes to the front: iOS cut the connection while it was away.
  func resume() {
    guard host.hop.filled else { return }
    switch phase {
    case .idle: connect()
    case .failed(let why) where why.hasPrefix(Self.lost): connect()
    default: break
    }
  }

  func disconnect() {
    task?.cancel()
    task = nil
    phase = .idle
    agents = []
  }

  private static let lost = "The connection"

  /// One attempt. A refused sign-in is never retried by itself: login nodes lock accounts out for that.
  /// A connection that worked and then dropped is retried once.
  func connect() {
    task?.cancel()
    agents = []
    phase = .connecting
    let host = host
    task = Task {
      var again = false
      repeat {
        let worked = await self.follow(host)
        guard !Task.isCancelled else { return }
        again = worked && !again
        if again { try? await Task.sleep(for: .seconds(3)) }
      } while again && !Task.isCancelled
    }
  }

  /// Signs in and shows the host's agents until the connection ends. True when it got as far as agents.
  private func follow(_ host: SavedHost) async -> Bool {
    var open: [SSHConnection] = []
    defer { open.forEach { $0.close() } }
    var worked = false
    refusal = nil
    phase = .connecting
    do {
      let key = try DeviceKey.load()
      let check: HostKeyCheck = { [weak self] name, key in await self?.trust(name, key) ?? false }
      func signIn(_ hop: Hop, via: SSHConnection?) async throws -> SSHConnection {
        let password = password(hop)
        return try await SSHConnection.connect(hop.target, auth: [.key(key)] + (password.isEmpty ? [] : [.password(password)]), via: via, hostKey: check)
      }
      if host.usesJump { open.append(try await signIn(host.jump, via: nil)) }
      open.append(try await signIn(host.hop, via: open.last))
      for try await event in watch(host: host.title, on: open.last!, shared: try Shared()) {
        switch event {
        case .installing: phase = .installing
        case .ready(let hostname, let claude): phase = .ready(hostname: hostname, claude: claude)
        case .agents(let agents):
          self.agents = agents
          worked = true
        }
      }
    } catch {
      guard !Task.isCancelled else { return false }
      phase = .failed(refusal ?? error.localizedDescription)
    }
    return worked
  }

  /// A host key this phone has seen for that name is trusted, another one for the same name is
  /// refused, and a name never seen is the user's call.
  private func trust(_ name: String, _ key: String) async -> Bool {
    var known = UserDefaults.standard.dictionary(forKey: "hostKeys") as? [String: [String]] ?? [:]
    if let keys = known[name] {
      if !keys.contains(key) { refusal = "\(name) shows another host key (\(fingerprint(openSSHKey: key))) than the one this phone trusts. Not connecting." }
      return keys.contains(key)
    }
    let yes = await withCheckedContinuation { answer in
      question = HostKeyQuestion(host: name, fingerprint: fingerprint(openSSHKey: key)) { answer.resume(returning: $0) }
    }
    if yes {
      known[name] = [key]
      UserDefaults.standard.set(known, forKey: "hostKeys")
    } else {
      refusal = "You did not trust \(name)."
    }
    return yes
  }
}
