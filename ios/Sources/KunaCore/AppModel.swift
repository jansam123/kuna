import Foundation
import NIOSSH
import Observation

/// "This phone has not seen that host's key before: trust it?"
public struct HostKeyQuestion: Identifiable {
  public let id = UUID()
  public let host: String
  public let fingerprint: String
  public let answer: (Bool) -> Void
}

public struct FolderTree: Identifiable, Hashable {
  public let folder: Folder
  /// "Other agents": what is on the project's host but in none of its folders
  public let other: Bool
  public var agents: [Agent]
  public var id: String { folder.id }
}

public struct ProjectTree: Identifiable, Hashable {
  public let project: Project
  public var folders: [FolderTree]
  public var id: String { project.id }
  public var agents: [Agent] { folders.flatMap(\.agents) }
}

/// One host the app keeps connected: its sign-in, its helper, its agents as they change.
@MainActor @Observable
public final class HostLink: Identifiable {
  public enum Phase: Equatable {
    case idle
    case connecting
    case installing
    case ready
    /// `final`: trying again by itself cannot help (a refused sign-in, a host key that changed)
    case failed(String, final: Bool)
  }

  public nonisolated let alias: String
  public internal(set) var phase = Phase.idle
  public internal(set) var agents: [Agent] = []
  /// a full list has arrived since the last (re)connect
  public internal(set) var synced = false
  public internal(set) var hostname = ""
  public internal(set) var home = ""
  public internal(set) var claude = true
  /// the host's clock minus the phone's, in seconds
  var clock = 0
  var lastFrame = Date.distantPast
  var task: Task<Void, Never>?

  init(alias: String) { self.alias = alias }
  public nonisolated var id: String { alias }
  public var ready: Bool { phase == .ready }
}

/// Everything the app knows and does that is not a screen: the saved projects and hosts, the
/// connections, the agents of every host, and what can be done to them.
@MainActor @Observable
public final class AppModel {
  public private(set) var state: PhoneState
  public private(set) var links: [String: HostLink] = [:]
  public private(set) var tree: [ProjectTree] = []
  public var question: HostKeyQuestion?
  public let themes: [Theme]
  public let repoColors: [String]
  /// this phone's ssh key, as a line for `authorized_keys`
  public let publicKey: String

  @ObservationIgnored private let shared = Shared.main
  @ObservationIgnored private let file: URL
  @ObservationIgnored private var connections: [String: SSHConnection] = [:]
  @ObservationIgnored private var opening: [String: Task<SSHConnection, Error>] = [:]
  @ObservationIgnored private var refusals: [String: String] = [:]
  @ObservationIgnored private var slots: [String: Slots] = [:]
  @ObservationIgnored private var pending: [String: Agent] = [:]
  @ObservationIgnored private var leaving: Task<Void, Never>?
  @ObservationIgnored private var active = false

  /// a key given by a test: then the keychain (the device key, passwords) is never touched
  @ObservationIgnored private let testKey: NIOSSHPrivateKey?

  /// `file`: where the state is kept, and `key`: the key to sign in with; tests give their own.
  public init(file: URL? = nil, key: NIOSSHPrivateKey? = nil) {
    self.file = file ?? URL.applicationSupportDirectory.appending(path: "Kuna/state.json")
    testKey = key
    themes = (try? shared.decode([Theme].self, "themes")) ?? []
    repoColors = (try? shared.decode([String].self, "repoColors")) ?? ["#4d8dff"]
    publicKey = (key ?? (try? DeviceKey.load())).map { openSSHPublicKey($0, comment: "kuna-iphone") } ?? ""
    if let data = try? Data(contentsOf: self.file), let saved = try? JSONDecoder().decode(PhoneState.self, from: data) {
      state = saved
    } else {
      state = file == nil ? Self.firstState() : PhoneState()
    }
    retree()
  }

  // ------------------------------------------------------------ state ----

  public var theme: Theme {
    themes.first { $0.id == state.theme } ?? themes.first ?? .fallback
  }

  /// Change what is saved; the tree and the set of connected hosts follow.
  public func update(_ change: (inout PhoneState) -> Void) {
    var next = state
    change(&next)
    guard next != state else { return }
    state = next
    save()
    retree()
    if active { rewatch() }
  }

  private func save() {
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(state).write(to: file, options: .atomic)
    } catch {
      // the next change tries again; what is on screen stays right meanwhile
      print("kuna: could not save state: \(error)")
    }
  }

  /// What step 1 of the app saved (one host, in the defaults): kept as a host with a project of its own.
  private static func firstState() -> PhoneState {
    struct OldHop: Decodable { var address: String; var port: Int; var user: String }
    struct OldHost: Decodable { var name: String; var hop: OldHop; var usesJump: Bool; var jump: OldHop }
    var state = PhoneState()
    let defaults = UserDefaults.standard
    guard let data = defaults.data(forKey: "host"), let old = try? JSONDecoder().decode(OldHost.self, from: data), !old.hop.address.isEmpty else { return state }
    var host = Host(alias: old.name.isEmpty ? old.hop.address : old.name, hostName: old.hop.address, user: old.hop.user, port: old.hop.port)
    host.alias = host.alias.replacingOccurrences(of: " ", with: "-")
    if old.usesJump, !old.jump.address.isEmpty {
      state.hosts.append(Host(alias: old.jump.address, hostName: old.jump.address, user: old.jump.user, port: old.jump.port))
      host.jump = old.jump.address
    }
    state.hosts.append(host)
    state.hostKeys = defaults.dictionary(forKey: "hostKeys") as? [String: [String]] ?? [:]
    state.projects = [Project(name: host.alias, host: host.alias, color: "#4d8dff")]
    return state
  }

  public func host(_ alias: String) -> Host? { state.hosts.first { $0.alias == alias } }

  public func password(_ host: Host) -> String {
    guard testKey == nil else { return "" }
    return Keychain.get(host.passwordAccount).map { String(decoding: $0, as: UTF8.self) } ?? ""
  }

  public func setPassword(_ host: Host, _ password: String) {
    guard testKey == nil else { return }
    Keychain.set(host.passwordAccount, Data(password.utf8))
  }

  /// Whether a name can be a host's alias: it ends up in agent keys and commands.
  public func validAlias(_ alias: String) -> Bool { (try? shared.call("validHost", [alias])) == "true" }

  /// Take in a file exported on the Mac. Says what it brought, or throws with why it is not one.
  @discardableResult
  public func importFile(_ text: String) throws -> String {
    let next = try shared.decode(PhoneState.self, "importFile", [json(state), text])
    let projects = next.fromMac.projects.count, hosts = next.fromMac.hosts.count
    update { $0 = next }
    return "\(projects) project\(projects == 1 ? "" : "s") on \(hosts) host\(hosts == 1 ? "" : "s")"
  }

  // -------------------------------------------------------- connecting ----

  /// The app came to the front: connect every host a project is on, or again where iOS cut it.
  public func becomeActive() {
    leaving?.cancel()
    leaving = nil
    active = true
    rewatch()
    for link in links.values {
      switch link.phase {
      case .ready where Date().timeIntervalSince(link.lastFrame) < 40: break
      case .connecting, .installing: break
      case .failed(_, final: true): break
      default: follow(link)
      }
    }
  }

  /// The app was left: connections stay for half a minute (a glance at another app), then close.
  public func enterBackground() {
    leaving?.cancel()
    leaving = Task { [weak self] in
      try? await Task.sleep(for: .seconds(30))
      guard !Task.isCancelled else { return }
      self?.disconnect()
    }
  }

  public func disconnect() {
    active = false
    for link in links.values {
      link.task?.cancel()
      link.task = nil
      if link.phase != .idle { link.phase = .idle }
    }
    connections.values.forEach { $0.close() }
    connections = [:]
  }

  /// Sign in to a host again now, e.g. after its password or key was fixed.
  public func reconnect(_ alias: String) {
    refusals[alias] = nil
    drop(alias)
    if let link = links[alias] { follow(link) }
  }

  /// Keep exactly the hosts with a project connected.
  private func rewatch() {
    let want = Set(state.projects.map(\.host))
    for (alias, link) in links where !want.contains(alias) {
      link.task?.cancel()
      links[alias] = nil
      if !state.hosts.contains(where: { $0.jump == alias }) { drop(alias) }
    }
    for alias in want where links[alias] == nil {
      let link = HostLink(alias: alias)
      links[alias] = link
      follow(link)
    }
    retree()
  }

  /// Sign in, follow the host's agents, and after a lost connection try again, each time a little later.
  private func follow(_ link: HostLink) {
    link.task?.cancel()
    let alias = link.alias
    link.task = Task { [weak self] in
      var wait = 2.0
      while !Task.isCancelled, let self {
        link.phase = .connecting
        link.synced = false
        do {
          let connection = try await self.connection(alias)
          for try await event in watch(host: alias, on: connection, shared: self.shared) {
            guard !Task.isCancelled else { return }
            switch event {
            case .installing: link.phase = .installing
            case .ready(let hostname, let home, let claude):
              link.hostname = hostname
              link.home = home
              link.claude = claude
              link.phase = .ready
            case .agents(let agents, let clock):
              link.clock = clock
              link.lastFrame = Date()
              link.synced = true
              wait = 2
              if agents != link.agents {
                link.agents = agents
                for agent in agents { self.pending[agent.key] = nil }
                self.retree()
              }
            }
          }
        } catch {
          guard !Task.isCancelled else { return }
          let final = (error as? KunaError)?.final ?? false
          link.phase = .failed(error.localizedDescription, final: final)
          if final { return }
        }
        self.drop(alias)
        try? await Task.sleep(for: .seconds(wait))
        wait = min(wait * 2, 60)
      }
    }
  }

  private func drop(_ alias: String) {
    connections[alias]?.close()
    connections[alias] = nil
  }

  /// The host's connection, opened once and shared: by the watch, by every command, and by the
  /// hosts that are reached through it.
  private func connection(_ alias: String, chain: [String] = []) async throws -> SSHConnection {
    if let open = connections[alias], open.isOpen { return open }
    connections[alias] = nil
    if let opening = opening[alias] { return try await opening.value }
    guard let host = host(alias) else { throw KunaError("No host called \(alias) is set up on this phone. Add it under Hosts.", final: true) }
    guard !chain.contains(alias), chain.count < 6 else { throw KunaError("\(alias) is set to be reached through itself.", final: true) }
    guard !host.target.host.isEmpty, !host.target.user.isEmpty else { throw KunaError("\(alias) has no address or user yet. Fill them in under Hosts.", final: true) }
    let task = Task { @MainActor [weak self] () throws -> SSHConnection in
      guard let self else { throw CancellationError() }
      var via: SSHConnection?
      if let jump = host.jump, !jump.isEmpty { via = try await self.connection(jump, chain: chain + [alias]) }
      let password = self.password(host)
      let auth: [SSHAuth] = [.key(try self.testKey ?? DeviceKey.load())] + (password.isEmpty ? [] : [.password(password)])
      do {
        return try await SSHConnection.connect(host.target, auth: auth, via: via) { [weak self] name, key in
          await self?.trust(alias: alias, name: name, key: key) ?? false
        }
      } catch {
        if let why = self.refusals[alias] { throw KunaError(why, final: true) }
        throw error
      }
    }
    opening[alias] = task
    defer { opening[alias] = nil }
    let made = try await task.value
    connections[alias] = made
    return made
  }

  /// A key known for the host is trusted, another one of the same kind is refused, and a host or
  /// kind of key this phone never saw is the user's call.
  private func trust(alias: String, name: String, key: String) async -> Bool {
    refusals[alias] = nil
    let print = fingerprint(openSSHKey: key)
    switch (try? shared.call("keyVerdict", [json(state.hostKeys[name] ?? []), key])) ?? "ask" {
    case "trusted": return true
    case "changed":
      refusals[alias] = "\(name) shows another host key (\(print)) than the one this phone trusts. Not connecting. If the host was reinstalled, remove its key under Hosts and connect again."
      return false
    default:
      while question != nil { try? await Task.sleep(for: .milliseconds(200)) }
      let yes = await withCheckedContinuation { answer in
        question = HostKeyQuestion(host: name, fingerprint: print) { answer.resume(returning: $0) }
      }
      if yes {
        update { $0.hostKeys[name, default: []].append(key) }
      } else {
        refusals[alias] = "You did not trust \(name)."
      }
      return yes
    }
  }

  public func answer(_ question: HostKeyQuestion, _ yes: Bool) {
    self.question = nil
    question.answer(yes)
  }

  /// Forget the keys trusted for a host, so the next connection asks again.
  public func forgetKeys(of host: Host) {
    update { $0.hostKeys[host.target.knownHostsName] = nil }
  }

  // ---------------------------------------------------------- commands ----

  /// Run Kuna's helper on a host. A few at a time per host: its watch and a terminal need their place too.
  public func run(_ alias: String, _ args: [String], stdin: Data? = nil, timeout: TimeInterval = 30) async throws -> ExecResult {
    let slot = slots[alias] ?? Slots(3)
    slots[alias] = slot
    await slot.take()
    defer { Task { await slot.give() } }
    return try await kuna(args, on: try await connection(alias), stdin: stdin, timeout: timeout)
  }

  /// The same, when only success matters: throws what the helper said.
  @discardableResult
  public func done(_ alias: String, _ args: [String], timeout: TimeInterval = 30, or fallback: String) async throws -> ExecResult {
    let result = try await run(alias, args, timeout: timeout)
    guard result.code == 0 else {
      let said = result.stderr.replacingOccurrences(of: "kuna: ", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
      throw KunaError(said.isEmpty ? fallback : said)
    }
    return result
  }

  /// A terminal on a host showing an agent's own screen.
  public func terminal(_ agent: Agent, cols: Int, rows: Int) async throws -> TerminalSession {
    let command = kunaCommand([agent.isBackground ? "cattach" : "attach", agent.isBackground ? String(agent.agentId.dropFirst(3)) : agent.agentId])
    return try await connection(agent.host).terminal(command, cols: cols, rows: rows)
  }

  // ------------------------------------------------------------ agents ----

  public var agents: [Agent] { links.values.flatMap(\.agents) + pending.values.filter { p in !links.values.contains { $0.agents.contains { $0.key == p.key } } } }

  public func agent(_ key: String) -> Agent? {
    for link in links.values { if let found = link.agents.first(where: { $0.key == key }) { return found } }
    return pending[key]
  }

  /// What to call an agent: the name given to it by hand, else what the Mac would call it.
  public func name(of agent: Agent) -> String { state.names[agent.key] ?? agent.title }

  public func rename(_ key: String, to name: String) {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    update { $0.names[key] = name.isEmpty ? nil : name }
  }

  /// Where an agent is shown: its project and folder.
  public func place(of key: String) -> (project: Project, folder: Folder)? {
    for p in tree { for f in p.folders where f.agents.contains(where: { $0.key == key }) { return (p.project, f.folder) } }
    return nil
  }

  private func retree() {
    struct Placed: Decodable {
      struct In: Decodable { var id: String; var agents: [String] }
      var id: String
      var folders: [In]
    }
    let all = agents
    let byKey = Dictionary(all.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    let lists = [json(all)]
    let homes = Dictionary(uniqueKeysWithValues: links.map { ($0.key, $0.value.home) })
    let placed = (try? shared.decode([Placed].self, "tree", [json(state.projects), lists, json(homes), json(state.hidden)])) ?? []
    let where_ = Dictionary(placed.map { ($0.id, $0.folders) }, uniquingKeysWith: { a, _ in a })
    let next = state.projects.map { project in
      let folders = where_[project.id] ?? []
      var out = project.folders.map { folder in
        FolderTree(folder: folder, other: false, agents: (folders.first { $0.id == folder.id }?.agents ?? []).compactMap { byKey[$0] })
      }
      let others = (folders.first { $0.id == "__other" }?.agents ?? []).compactMap { byKey[$0] }
      if !others.isEmpty {
        var folder = Folder(id: "__other", path: "", name: "Other agents", color: "#6b7280")
        folder.collapsed = project.otherCollapsed
        out.append(FolderTree(folder: folder, other: true, agents: others))
      }
      return ProjectTree(project: project, folders: out)
    }
    if next != tree { tree = next }
  }

  private func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

  /// Start an agent in a folder, as the Mac does: a Claude Code background session, or a tmux
  /// session of Kuna's for any other command (or when the project asks for tmux).
  @discardableResult
  public func spawn(project: Project, folder: Folder, prompt: String) async throws -> String {
    guard let link = links[project.host], link.ready else { throw KunaError("\(project.host) is not connected.") }
    let base = project.agentCommand.trimmingCharacters(in: .whitespaces).isEmpty ? "claude" : project.agentCommand.trimmingCharacters(in: .whitespaces)
    let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    let now = Int(Date().timeIntervalSince1970)
    var placeholder: [String: Any] = [
      "host": project.host, "cwd": folder.path, "projectId": project.id, "folderId": folder.id, "createdAt": now, "prompt": String(prompt.prefix(300)),
      "status": "starting", "alive": true, "attnTs": 0, "activityTs": now, "transcriptSize": 0, "doing": "starting",
      "title": prompt.split(separator: "\n").first.map(String.init) ?? "New agent",
    ]
    let key: String
    if project.startsClaude, (project.launch ?? "background") == "background" {
      guard link.claude else { throw KunaError("Claude Code was not found on \(project.host).") }
      let command = "\(base) --bg --settings \"$HOME/.kuna/claude-hooks.json\""
      let made = try await done(project.host, ["bgspawn", b64(folder.path), b64(command), b64(prompt)], timeout: 60, or: "claude --bg did not start a session.")
      let short = made.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard short.range(of: "^[0-9a-f]{8}$", options: .regularExpression) != nil else { throw KunaError("claude --bg did not say which session it started.") }
      key = "\(project.host)::cc-\(short)"
      placeholder.merge(["key": key, "id": "cc-\(short)", "kind": "claude"]) { $1 }
    } else {
      let id = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
      let session = UUID().uuidString.lowercased()
      var command = base
      // the helper adds the prompt as the last argument, in the login shell's own syntax
      if project.startsClaude { command += " --session-id \(session) --settings \"$HOME/.kuna/claude-hooks.json\"" }
      var meta: [String: Any] = ["id": id, "cwd": folder.path, "projectId": project.id, "folderId": folder.id, "createdAt": now + link.clock, "prompt": String(prompt.prefix(300)), "command": base]
      if project.startsClaude { meta["sessionId"] = session }
      let metaText = String(decoding: try JSONSerialization.data(withJSONObject: meta), as: UTF8.self)
      try await done(project.host, ["spawn", id, b64(folder.path), b64(command), "80", "30", b64(metaText), b64(prompt)], or: "The agent did not start.")
      key = "\(project.host)::\(id)"
      placeholder.merge(["key": key, "id": id, "kind": "tmux"]) { $1 }
    }
    if agent(key) == nil, let data = try? JSONSerialization.data(withJSONObject: placeholder), let agent = try? JSONDecoder().decode(Agent.self, from: data) {
      // shown as starting until the host's next report has it
      pending[key] = agent
      retree()
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(120))
        if self?.pending[key] != nil {
          self?.pending[key] = nil
          self?.retree()
        }
      }
    }
    return key
  }

  /// Stop an agent. One of Kuna's own (tmux) is ended and gone from the list; a Claude Code
  /// background session stops and keeps its conversation (`claude stop`, never `claude rm`).
  public func stop(_ agent: Agent) async throws {
    if agent.isBackground {
      guard agent.alive else { return }
      let result = try await run(agent.host, ["cc", "stop", String(agent.agentId.dropFirst(3))], timeout: 60)
      guard result.code == 0 else { throw KunaError(firstWords(result.text, result.stderr, or: "claude stop failed.")) }
    } else {
      pending[agent.key] = nil
      links[agent.host]?.agents.removeAll { $0.key == agent.key }
      retree()
      try await done(agent.host, ["kill", agent.agentId], timeout: 20, or: "Could not stop the agent.")
    }
  }

  /// Take a stopped background session off the list (its conversation stays on the host), or bring it back.
  public func hide(_ key: String, _ hidden: Bool = true) {
    update { $0.hidden[key] = hidden ? Date().timeIntervalSince1970 : nil }
  }

  /// Type a line into one of Kuna's own agents and press Enter. Background sessions take input
  /// only through an attached terminal (`AgentSession.send`).
  public func type(_ agent: Agent, _ text: String) async throws {
    try await done(agent.host, ["send", agent.agentId, b64(text)], timeout: 15, or: "Could not type into the agent.")
  }

  private func firstWords(_ texts: String..., or fallback: String) -> String {
    texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }.map { String($0.prefix(300)) } ?? fallback
  }
}

/// A few places at a time: who comes when all are taken waits for one to be given back.
actor Slots {
  private var free: Int
  private var waiting: [CheckedContinuation<Void, Never>] = []
  init(_ count: Int) { free = count }

  func take() async {
    if free > 0 {
      free -= 1
      return
    }
    await withCheckedContinuation { waiting.append($0) }
  }

  func give() {
    if waiting.isEmpty { free += 1 } else { waiting.removeFirst().resume() }
  }
}
