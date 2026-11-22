import Foundation

public enum HostEvent: Sendable {
  /// the helper script is being put on the host (first use, or after a Kuna update)
  case installing
  case ready(hostname: String, home: String, claude: Bool)
  /// every agent on the host, each time something changed; `clock`: the host's clock minus the phone's, in seconds
  case agents([Agent], clock: Int)
}

/// Makes sure the host has Kuna's helper, then follows its watch stream (as `Host` in
/// src/main/hosts/host.ts). Ends by throwing: when the connection is lost, or the host can't run agents.
public func watch(host: String, on connection: SSHConnection, shared: Shared = .main) -> AsyncThrowingStream<HostEvent, Error> {
  AsyncThrowingStream { continuation in
    let last = LastFrame()
    let follow = Task {
      do {
        try await prepare(host: host, on: connection, shared: shared) { continuation.yield($0) }
        var buffer = Data()
        var lines: [String] = []
        for try await chunk in connection.stream("sh \(helper) watch") {
          buffer.append(chunk)
          while let end = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<end], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...end)
            guard line.hasPrefix("@@END\t") else {
              lines.append(line)
              continue
            }
            let here = Int(Date().timeIntervalSince1970)
            let now = Int(line.dropFirst(6)) ?? here
            let agents = try shared.agents(host: host, lines: lines, now: now, offset: now - here)
            last.set(lines: lines, now: now, offset: now - here, agents: agents)
            continuation.yield(.agents(agents, clock: now - here))
            lines = []
          }
          // a frame is a few KB; a stream that never ends one is not Kuna's helper talking
          if buffer.count > 1 << 20 || lines.count > 20_000 {
            buffer = Data()
            lines = []
          }
        }
        throw KunaError("The connection to \(host) was lost.")
      } catch {
        continuation.finish(throwing: error)
      }
    }
    // "starting" and "working" expire with time, but a quiet agent sends no new frame: re-derive
    // them from the last one. The same clock notices a dead connection: the helper sends a
    // heartbeat every 30 s, so 50 s of silence is one (as on the Mac).
    let clock = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        guard let frame = last.get() else { continue }
        let age = Int(Date().timeIntervalSince(frame.at))
        if age > 50 { return follow.cancel() }
        guard frame.agents.contains(where: { $0.kind == "tmux" && ($0.status == "starting" || $0.status == "working") }),
          let agents = try? shared.agents(host: host, lines: frame.lines, now: frame.now + age, offset: frame.offset),
          agents.map(\.status) != frame.agents.map(\.status)
        else { continue }
        last.set(agents: agents)
        continuation.yield(.agents(agents, clock: frame.offset))
      }
    }
    continuation.onTermination = { _ in
      follow.cancel()
      clock.cancel()
    }
  }
}

/// ssh commands start in the home folder
private let helper = ".kuna/bin/kuna"

/// Every command but `watch` goes through `within`, which stops it on the host a little before we give up on it.
public func kuna(_ args: [String], on connection: SSHConnection, stdin: Data? = nil, timeout: TimeInterval = 30) async throws -> ExecResult {
  try await connection.run(kunaCommand(["within", String(max(1, Int(timeout) - 2))] + args), stdin: stdin, timeout: timeout)
}

/// The helper's command line for the host's shell.
public func kunaCommand(_ args: [String]) -> String {
  (["sh", helper] + args).map(shq).joined(separator: " ")
}

private func prepare(host: String, on connection: SSHConnection, shared: Shared, report: (HostEvent) -> Void) async throws {
  let version = try await kuna(["version"], on: connection)
  let doctor: ExecResult
  if version.text.trimmingCharacters(in: .whitespacesAndNewlines) != shared.version {
    report(.installing)
    // a new file moved into place: agents already running keep reading the old one
    let install = #"sh -c 'mkdir -p "$HOME/.kuna/bin" && chmod 700 "$HOME/.kuna" && cat > "$HOME/.kuna/bin/kuna.tmp" && chmod 755 "$HOME/.kuna/bin/kuna.tmp" && mv -f "$HOME/.kuna/bin/kuna.tmp" "$HOME/.kuna/bin/kuna"'"#
    let installed = try await connection.run(install, stdin: Data(shared.script.utf8))
    guard installed.code == 0 else { throw KunaError("Could not install Kuna's helper on \(host): \(firstLine(installed.stderr))") }
    doctor = try await kuna(["setup"], on: connection, timeout: 60)
  } else {
    doctor = try await kuna(["doctor"], on: connection, timeout: 20)
  }
  guard doctor.code == 0 else { throw KunaError("Kuna's helper failed to run on \(host): \(firstLine(doctor.stderr))") }
  var info: [String: String] = [:]
  for line in doctor.text.split(separator: "\n") {
    let parts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
    if parts.count == 2 { info[String(parts[0])] = String(parts[1]) }
  }
  guard info["tmux", default: ""] != "" else { throw KunaError("tmux was not found on \(host). Install tmux there and reconnect.", final: true) }
  report(.ready(hostname: info["hostname"] ?? host, home: info["home"] ?? "", claude: info["claude", default: ""] != ""))
}

private func firstLine(_ text: String) -> String {
  String(text.split(separator: "\n").first { !$0.lowercased().hasPrefix("warning:") } ?? "no message").prefix(300).description
}

private final class LastFrame: @unchecked Sendable {
  struct Frame {
    var lines: [String]
    var now: Int
    var offset: Int
    var agents: [Agent]
    var at: Date
  }
  private let lock = NSLock()
  private var frame: Frame?

  func get() -> Frame? { lock.withLock { frame } }
  func set(lines: [String], now: Int, offset: Int, agents: [Agent]) {
    lock.withLock { frame = Frame(lines: lines, now: now, offset: offset, agents: agents, at: Date()) }
  }
  func set(agents: [Agent]) { lock.withLock { frame?.agents = agents } }
}
