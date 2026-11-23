import Foundation
import Observation
import os

/// How long the list of models takes, step by step (`log stream --level debug --predicate 'category == "models"'`).
public let modelsLog = Logger(subsystem: "io.github.jansam123.Kuna", category: "models")

/// One agent while its screen is open: its conversation as the transcript grows, and its
/// terminal once that is asked for.
@MainActor @Observable
public final class AgentSession {
  public struct Outgoing: Identifiable, Hashable {
    public let id = UUID()
    public let text: String
    let sent = Date()
    let had: Int
  }

  public struct Queued: Identifiable, Hashable {
    public let id = UUID()
    public let text: String
  }

  public nonisolated let key: String
  public private(set) var items: [ChatItem] = []
  public private(set) var details: ChatDetails?
  /// the conversation has been read once, or there is none to read
  public private(set) var loaded = false
  /// messages sent from here that the transcript does not show yet
  public private(set) var outbox: [Outgoing] = []
  /// messages written while the agent was at work: typed into it, together, once its turn is over
  public private(set) var queued: [Queued] = []
  /// why the queued messages could not be typed when the turn was over
  public private(set) var queueProblem: String?
  public private(set) var terminal: TerminalSession?
  public private(set) var attaching = false
  /// the terminal closed by itself (the agent ended, or the connection did)
  public private(set) var terminalEnded = false
  /// the question or panel on the agent's screen, while its terminal is open
  public private(set) var panel: Panel?

  /// where the terminal's output goes as it comes (the terminal view)
  @ObservationIgnored public var onOutput: ((Data) -> Void)?
  /// the terminal's screen as lines of text, for telling whether the agent can be typed into
  @ObservationIgnored public var screen: (() -> [String])?
  /// the size the terminal view has, for a terminal opened before it is shown
  @ObservationIgnored public var size = (cols: 60, rows: 32)

  @ObservationIgnored private let model: AppModel
  @ObservationIgnored private let shared = Shared.main
  @ObservationIgnored private var path = ""
  @ObservationIgnored private var offset = 0
  @ObservationIgnored private var carry = Data()
  @ObservationIgnored private var busy = false
  @ObservationIgnored private var again = false
  @ObservationIgnored private var reader: Task<Void, Never>?
  @ObservationIgnored private var replay = Data()
  @ObservationIgnored private var lastOutput = Date.distantPast
  @ObservationIgnored private var gotOutput = false
  /// output that came, counted, for reading the screen only when it changed
  @ObservationIgnored private var outputs = 0
  @ObservationIgnored private var draining: Task<Void, Never>?
  /// the host's own commands and skills, asked for once
  @ObservationIgnored private var found: String?

  /// the most of a transcript read at first, and in one go after that
  private static let firstRead = 1_500_000
  private static let nextRead = 4_000_000
  /// End, then Ctrl+U and Backspace for each of up to six lines: empties Claude Code's input box (`CLEAR_INPUT` in src/shared/input.ts)
  private static let clearInput = "\u{05}" + String(repeating: "\u{15}\u{7f}", count: 6)

  public init(key: String, model: AppModel) {
    self.key = key
    self.model = model
  }

  // ------------------------------------------------------ conversation ----

  /// Read what the transcript gained since the last time.
  public func pull() async {
    guard let agent = model.agent(key) else { return }
    guard let path = agent.transcriptPath, !path.isEmpty else {
      loaded = true
      return
    }
    if busy {
      again = true
      return
    }
    busy = true
    defer {
      busy = false
      if again {
        again = false
        Task { await self.pull() }
      }
    }
    var restart = false
    let size = Int(agent.transcriptSize)
    if path != self.path || (size > 0 && size < offset) {
      // another conversation, or the file was written anew
      self.path = path
      offset = 0
      carry = Data()
      restart = true
    }
    var fromMiddle = false
    if offset == 0, size > Self.firstRead {
      offset = size - Self.firstRead
      fromMiddle = true
    }
    do {
      let read = try await model.run(agent.host, ["read", Data(path.utf8).base64EncodedString(), String(offset), String(Self.nextRead)], timeout: 60)
      guard read.code == 0, path == self.path else {
        loaded = true
        return
      }
      if !read.stdout.isEmpty || restart {
        offset += read.stdout.count
        var data = carry + read.stdout
        if fromMiddle {
          // started inside a line (maybe inside a character): from the next line on
          data = data.firstIndex(of: 0x0A).map { data[data.index(after: $0)...] } ?? Data()
        }
        // hold back a character cut in the middle, for the next read to finish
        var held = 0
        var text = String(data: data, encoding: .utf8)
        while text == nil, held < 3, data.count > held {
          held += 1
          text = String(data: data.dropLast(held), encoding: .utf8)
        }
        carry = text == nil ? Data() : Data(data.suffix(held))
        try shared.call("chatFeed", [key, text ?? String(decoding: data, as: UTF8.self), false, restart])
        let state = try shared.decode(ChatState.self, "chatState", [key, 200])
        if state.items != items { items = state.items }
        if state.details != details { details = state.details }
        settleOutbox()
      }
    } catch {
      // the connection dropped: the next pull reads on from the same place
    }
    loaded = true
  }

  /// Keep the conversation up to date while its screen is open: often during a turn, rarely otherwise.
  public func follow() async {
    while !Task.isCancelled {
      await pull()
      let status = model.agent(key)?.status ?? "idle"
      let quick = status == "working" || status == "starting" || !outbox.isEmpty
      try? await Task.sleep(for: .seconds(quick ? 3 : 10))
    }
  }

  /// Media the conversation mentioned, newest reply first, as paths on the host.
  public func mentionedFiles(limit: Int = 120) -> [String] {
    guard let agent = model.agent(key) else { return [] }
    return (try? shared.decode([String].self, "mediaPaths", [key, agent.base, limit])) ?? []
  }

  private func settleOutbox() {
    guard !outbox.isEmpty else { return }
    let users = items.filter { $0.kind == "user" }
    // sent in the middle of a turn, a message waits in Claude Code's queue until the turn is over
    let queued = model.agent(key)?.status == "working"
    outbox.removeAll { out in
      !queued && Date().timeIntervalSince(out.sent) > 90 || users.count > out.had && users.suffix(users.count - out.had).contains { $0.text.hasPrefix(out.text.prefix(40)) }
    }
  }

  // ----------------------------------------------------------- sending ----

  /// Send a message to the agent as if typed into it and sent. Kuna's own agents get it through
  /// tmux; a Claude Code background session only takes input on its own screen, so that is opened
  /// (which also starts a stopped session again). In the middle of a turn it is queued here
  /// instead (`queued`) and typed once the turn is over; it returns false then.
  @discardableResult
  public func send(_ text: String) async throws -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return true }
    guard let agent = model.agent(key) else { throw KunaError("The agent is no longer on the host.") }
    // typed now it would land wherever the turn goes on: a question, a permission, a panel
    if agent.status == "working" || !queued.isEmpty {
      queued.append(Queued(text: text))
      queueProblem = nil
      drain()
      return false
    }
    try await deliver(text, agent)
    return true
  }

  /// Take a queued message back before it is typed.
  public func unqueue(_ id: UUID) {
    queued.removeAll { $0.id == id }
    if queued.isEmpty { queueProblem = nil }
  }

  /// Type the queued messages, as one, once the agent has been out of its turn for two seconds;
  /// not while it waits for an answer, which they would give.
  private func drain() {
    guard draining == nil else { return }
    draining = Task { [weak self] in
      var calm = 0
      while !Task.isCancelled, let self, !self.queued.isEmpty {
        let status = self.model.agent(self.key)?.status ?? "working"
        calm = ["working", "starting", "waiting"].contains(status) ? 0 : calm + 1
        if calm >= 2, let agent = self.model.agent(self.key) {
          let now = self.queued
          do {
            try await self.deliver(now.map(\.text).joined(separator: "\n\n"), agent)
            self.queued.removeAll { out in now.contains { $0.id == out.id } }
          } catch {
            // kept, to be taken back, or typed once the agent can be typed into
            self.queueProblem = error.localizedDescription
            try? await Task.sleep(for: .seconds(10))
          }
          calm = 0
          continue
        }
        try? await Task.sleep(for: .seconds(1))
      }
      self?.draining = nil
    }
  }

  private func deliver(_ text: String, _ agent: Agent) async throws {
    let had = items.filter { $0.kind == "user" }.count
    try await type(text, agent)
    // a command of Claude Code's own may open a panel: its screen is opened to show it
    if text.hasPrefix("/"), !agent.isBackground { Task { try? await self.attach() } }
    outbox.append(Outgoing(text: text, had: had))
    Task {
      try? await Task.sleep(for: .seconds(2))
      await self.pull()
    }
  }

  /// Run a command of Claude Code's own whose panel the app shows itself (`/model`): it is typed
  /// and the agent's screen opened, to read the panel off it. Nothing is added to the conversation.
  public func command(_ text: String) async throws {
    guard let agent = model.agent(key) else { throw KunaError("The agent is no longer on the host.") }
    if agent.status == "waiting" { throw KunaError("It is waiting for you. Answer it first.") }
    modelsLog.debug("command \(text, privacy: .public): typing")
    defer { modelsLog.debug("command \(text, privacy: .public): typed") }
    if agent.isBackground {
      try await type(text, agent, quick: true)
    } else {
      async let opened: Void = attach()
      try await type(text, agent, quick: true)
      try await opened
    }
  }

  /// `quick`: a command such as `/model` (no free text), which Claude Code takes typed in one go with
  /// its Enter (a message may be long enough to be taken as a paste, and is sent as text)
  private func type(_ text: String, _ agent: Agent, quick: Bool = false) async throws {
    if agent.isBackground {
      try await attach()
      if let why = await waitForInput(seconds: agent.alive ? 25 : 60) { throw KunaError(why) }
      guard let terminal else { throw KunaError("Its screen closed; nothing was typed.") }
      terminal.write(Self.clearInput)
      try? await Task.sleep(for: .milliseconds(quick ? 30 : 120))
      terminal.write(text)
      // Enter on its own, so Claude Code takes it as a key and not as part of a paste
      try? await Task.sleep(for: .milliseconds(quick ? 30 : 200))
      terminal.write("\r")
    } else {
      guard agent.alive else { throw KunaError("The agent has exited. Start a new one in its folder.") }
      // scrolled back on the Mac: tmux would take the message's keys as its own
      if agent.inCopyMode == true { _ = try? await model.run(agent.host, ["key", agent.agentId, "-X", "cancel"], timeout: 10) }
      if quick {
        // the input box emptied as `kuna send` does, then the command and Enter, in one tmux call and without its pause
        try await model.done(agent.host, ["key", agent.agentId, "C-e"] + Array(repeating: ["C-u", "BSpace"], count: 6).flatMap { $0 } + [text, "Enter"], timeout: 15, or: "Could not type into the agent.")
      } else {
        try await model.type(agent, text)
      }
    }
  }

  /// Wait until the terminal has stopped drawing and shows Claude Code's input box. Returns why not otherwise.
  private func waitForInput(seconds: Double) async -> String? {
    let start = Date()
    var seen = "unknown"
    while Date().timeIntervalSince(start) < seconds {
      if terminalEnded { return "Its screen closed; nothing was typed." }
      // Claude Code starting draws in bursts at most 0.3 s apart, then stops
      if gotOutput, Date().timeIntervalSince(lastOutput) > 0.4, let lines = screen?() {
        seen = (try? shared.call("screen", [lines])) ?? "unknown"
        // in the middle of a turn Claude Code takes what is typed and reads it when it can
        if seen == "input" || seen == "busy" {
          modelsLog.debug("input box after \(Date().timeIntervalSince(start), format: .fixed(precision: 2)) s")
          return nil
        }
      }
      try? await Task.sleep(for: .milliseconds(50))
    }
    switch seen {
    case "question": return "It is waiting for an answer. Open its terminal and answer there first."
    case "menu": return "A panel is open on its screen (Esc closes it). Open its terminal; nothing was typed."
    default: return "Its input box did not show up, so nothing was typed. Open its terminal to see why."
    }
  }

  // ------------------------------------------------- panels and commands ----

  /// Keep `panel` as the agent's screen shows it, for as long as this runs (the conversation is on screen).
  /// The screen is read when output came and has paused for a moment (one frame drawn in
  /// pieces is read once it is whole), or every 0.3 s while it keeps coming.
  public func watchScreen() async {
    var read = -1
    var waited = 0
    while !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(30))
      guard terminal != nil, let lines = screen?() else {
        if panel != nil { panel = nil }
        read = -1
        continue
      }
      guard outputs != read else { continue }
      waited += 1
      guard Date().timeIntervalSince(lastOutput) > 0.025 || waited >= 10 else { continue }
      read = outputs
      waited = 0
      let now = (try? shared.decode(Panel?.self, "panel", [lines])) ?? nil
      if now != panel {
        if (now?.model != nil) != (panel?.model != nil) { modelsLog.debug("list of models \(now?.model != nil ? "on" : "off", privacy: .public) the screen") }
        panel = now
      }
    }
  }

  /// Press keys on the agent's own screen (a row of a panel, Esc, Shift+Tab), opening it first.
  public func press(_ keys: String) async throws {
    try await attach()
    key(Data(keys.utf8))
  }

  /// Type an answer of one's own into the open question's "Type something." row: its keys walk the
  /// `❯` there and empty it, the text follows, then Enter (none under checkboxes, where typing ticks
  /// the row and Enter would untick it). Apart, so Claude Code does not take them for a paste.
  public func answer(_ text: String) async throws {
    let text = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    guard let row = panel?.options.first(where: { $0.answer != nil }), let after = row.answer else {
      throw KunaError("The question is no longer open on its screen; nothing was typed.")
    }
    try await attach()
    key(Data(row.keys.utf8))
    try? await Task.sleep(for: .milliseconds(250))
    write(text)
    guard !after.isEmpty else { return }
    try? await Task.sleep(for: .milliseconds(250))
    key(Data(after.utf8))
  }

  /// The slash commands to offer for what is typed so far: Claude Code's own, and the host's once it has said them.
  public func slash(_ typed: String) -> [SlashCommand] {
    guard typed.hasPrefix("/") else { return [] }
    if found == nil, let agent = model.agent(key) {
      found = "[]"
      Task {
        let listed = try? await model.run(agent.host, ["claude-files", Data(agent.base.utf8).base64EncodedString()], timeout: 30)
        if let listed, listed.code == 0 { found = (try? shared.call("slashFound", [listed.text])) ?? "[]" }
      }
    }
    return (try? shared.decode([SlashCommand].self, "slash", [typed, found ?? "[]"])) ?? []
  }

  // ---------------------------------------------------------- terminal ----

  /// Open the agent's own screen (or fit the one already open to a new size).
  public func attach() async throws {
    if let terminal, terminal.isOpen {
      terminal.resize(cols: size.cols, rows: size.rows)
      return
    }
    while attaching { try? await Task.sleep(for: .milliseconds(100)) }
    if let terminal, terminal.isOpen { return }
    guard let agent = model.agent(key) else { throw KunaError("The agent is no longer on the host.") }
    attaching = true
    defer { attaching = false }
    reader?.cancel()
    modelsLog.debug("terminal: opening")
    let session = try await model.terminal(agent, cols: size.cols, rows: size.rows)
    modelsLog.debug("terminal: open")
    terminal = session
    terminalEnded = false
    gotOutput = false
    replay = Data()
    reader = Task { [weak self] in
      for await data in session.output { self?.received(data) }
      guard !Task.isCancelled else { return }
      self?.ended(session)
    }
  }

  private func received(_ data: Data) {
    if !gotOutput { modelsLog.debug("terminal: first output") }
    lastOutput = Date()
    gotOutput = true
    outputs += 1
    replay.append(data)
    if replay.count > 600_000 { replay = Data(replay.suffix(300_000)) }
    onOutput?(data)
  }

  private func ended(_ session: TerminalSession) {
    guard terminal === session else { return }
    terminal = nil
    terminalEnded = true
  }

  /// What the terminal drew so far, for a view that is shown after it was opened.
  public var drawnSoFar: Data { replay }

  public func resize(cols: Int, rows: Int) {
    guard cols > 1, rows > 1, (cols, rows) != size else { return }
    size = (cols, rows)
    terminal?.resize(cols: cols, rows: rows)
  }

  public func write(_ text: String) { terminal?.write(text) }
  public func write(_ data: Data) { terminal?.write(data) }

  /// Keys meant for the agent.
  public func key(_ data: Data) { terminal?.write(data) }

  /// The agent runs in a pane of Kuna's tmux, whose history the host can be asked for.
  public var hasPane: Bool { model.agent(key).map { !$0.isBackground } ?? false }

  /// What its pane scrolled past and shows now, as `kuna scrollback` prints it, from line `from`
  /// of its history. Nil where there is no pane to ask, or the host did not answer.
  public func scrollback(from: Int) async -> String? {
    guard let agent = model.agent(key), !agent.isBackground, agent.alive else { return nil }
    guard let got = try? await model.run(agent.host, ["scrollback", agent.agentId, String(from)], timeout: 20), got.code == 0 else { return nil }
    return got.text
  }

  /// Close the terminal; the agent itself keeps running on the host.
  public func detach() {
    reader?.cancel()
    reader = nil
    terminal?.close()
    terminal = nil
  }

  /// The agent's screen was left.
  public func close() {
    detach()
    try? shared.call("chatDrop", [key])
    try? shared.call("backDrop", [key])
  }
}
