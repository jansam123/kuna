import Foundation
import Observation

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

  public nonisolated let key: String
  public private(set) var items: [ChatItem] = []
  public private(set) var details: ChatDetails?
  /// the conversation has been read once, or there is none to read
  public private(set) var loaded = false
  /// messages sent from here that the transcript does not show yet
  public private(set) var outbox: [Outgoing] = []
  public private(set) var terminal: TerminalSession?
  public private(set) var attaching = false
  /// the terminal closed by itself (the agent ended, or the connection did)
  public private(set) var terminalEnded = false

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
  /// the terminal was scrolled back with the wheel since the last key
  @ObservationIgnored public var scrolledBack = false
  @ObservationIgnored private var held: Data?

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
    outbox.removeAll { out in
      Date().timeIntervalSince(out.sent) > 90 || users.count > out.had && users.suffix(users.count - out.had).contains { $0.text.hasPrefix(out.text.prefix(40)) }
    }
  }

  // ----------------------------------------------------------- sending ----

  /// Send a message to the agent as if typed into it and sent. Kuna's own agents get it through
  /// tmux; a Claude Code background session only takes input on its own screen, so that is opened
  /// (which also starts a stopped session again).
  public func send(_ text: String) async throws {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    guard let agent = model.agent(key) else { throw KunaError("The agent is no longer on the host.") }
    let had = items.filter { $0.kind == "user" }.count
    if agent.isBackground {
      try await attach()
      if let why = await waitForInput(seconds: agent.alive ? 25 : 60) { throw KunaError(why) }
      guard let terminal else { throw KunaError("Its screen closed; nothing was typed.") }
      terminal.write(Self.clearInput)
      try? await Task.sleep(for: .milliseconds(120))
      terminal.write(text)
      // Enter on its own, so Claude Code takes it as a key and not as part of a paste
      try? await Task.sleep(for: .milliseconds(200))
      terminal.write("\r")
    } else {
      guard agent.alive else { throw KunaError("The agent has exited. Start a new one in its folder.") }
      // scrolled back, here or on the Mac: tmux would take the message's keys as its own
      if scrolledBack || agent.inCopyMode == true { await leaveScroll(agent) }
      try await model.type(agent, text)
    }
    outbox.append(Outgoing(text: text, had: had))
    Task {
      try? await Task.sleep(for: .seconds(2))
      await self.pull()
    }
  }

  /// Wait until the terminal has stopped drawing and shows Claude Code's input box. Returns why not otherwise.
  private func waitForInput(seconds: Double) async -> String? {
    let start = Date()
    var seen = "unknown"
    while Date().timeIntervalSince(start) < seconds {
      if terminalEnded { return "Its screen closed; nothing was typed." }
      if gotOutput, Date().timeIntervalSince(lastOutput) > 0.7, let lines = screen?() {
        seen = (try? shared.call("screen", [lines])) ?? "unknown"
        if seen == "input" { return nil }
      }
      try? await Task.sleep(for: .milliseconds(250))
    }
    switch seen {
    case "question": return "It is waiting for an answer. Open its terminal and answer there first."
    case "menu": return "A panel is open on its screen (Esc closes it). Open its terminal; nothing was typed."
    case "busy": return "It is in the middle of a turn. Send it once it is idle, or open its terminal."
    default: return "Its input box did not show up, so nothing was typed. Open its terminal to see why."
    }
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
    let session = try await model.terminal(agent, cols: size.cols, rows: size.rows)
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
    lastOutput = Date()
    gotOutput = true
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

  /// Keys meant for the agent. After the terminal was scrolled back, tmux's scroll mode would take
  /// them as its own: it is left first, and what is typed meanwhile waits its turn (`leaveScroll` on the Mac).
  public func key(_ data: Data) {
    if held != nil {
      held?.append(data)
      return
    }
    guard scrolledBack, let agent = model.agent(key), !agent.isBackground else {
      terminal?.write(data)
      return
    }
    held = data
    Task {
      await leaveScroll(agent)
      if let held { terminal?.write(held) }
      held = nil
    }
  }

  /// Not in scroll mode any more (scrolled back down to the end): tmux says so, and nothing is lost.
  private func leaveScroll(_ agent: Agent) async {
    scrolledBack = false
    _ = try? await model.run(agent.host, ["key", agent.agentId, "-X", "cancel"], timeout: 10)
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
  }
}
