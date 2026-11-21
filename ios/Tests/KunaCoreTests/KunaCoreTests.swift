import CryptoKit
import Foundation
import NIOSSH
import Testing

@testable import KunaCore

/// A throwaway sshd on this Mac: its own host key, one accepted client key, a temporary HOME and
/// a private tmux socket, so nothing of the user's is touched (as test/host.integration.test.ts).
final class TestServer {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kuna-ios-\(UUID().uuidString.prefix(8))")
  let key = NIOSSHPrivateKey(p256Key: .init())
  let socket = "kuna-ios-test-\(ProcessInfo.processInfo.processIdentifier)"
  let port: Int
  let sshd = Process()
  var hostKey = ""
  var target: SSHTarget { SSHTarget(host: "127.0.0.1", port: port, user: NSUserName()) }

  init() throws {
    let home = dir.appendingPathComponent("home")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    try sh("ssh-keygen -q -t ed25519 -N '' -f \(dir.path)/hostkey")
    hostKey = try String(contentsOf: dir.appendingPathComponent("hostkey.pub"), encoding: .utf8).split(separator: " ").prefix(2).joined(separator: " ")
    try openSSHPublicKey(key, comment: "test").write(to: dir.appendingPathComponent("authorized_keys"), atomically: true, encoding: .utf8)
    port = try freePort()
    try """
      Port \(port)
      ListenAddress 127.0.0.1
      HostKey \(dir.path)/hostkey
      PidFile none
      AuthorizedKeysFile \(dir.path)/authorized_keys
      StrictModes no
      UsePAM no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PerSourcePenalties no
      SetEnv HOME=\(home.path) SHELL=/bin/sh KUNA_TMUX_SOCKET=\(socket) "PATH=\(ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin")"
      ForceCommand cd "$HOME" && exec sh -c "$SSH_ORIGINAL_COMMAND"
      """.write(to: dir.appendingPathComponent("sshd_config"), atomically: true, encoding: .utf8)
    sshd.executableURL = URL(fileURLWithPath: "/usr/sbin/sshd")
    sshd.arguments = ["-D", "-e", "-f", dir.path + "/sshd_config"]
    let log = Pipe()
    sshd.standardError = log
    try sshd.run()
    // wait for its "Server listening" line: a probe connection would count against us as a failed sign-in
    var said = ""
    while !said.contains("listening"), sshd.isRunning || !said.isEmpty {
      let more = log.fileHandleForReading.availableData
      if more.isEmpty { break }
      said += String(decoding: more, as: UTF8.self)
    }
    guard said.contains("listening") else { throw KunaError("sshd did not start: \(said)") }
    // keep its pipe drained, or it blocks once the pipe is full
    log.fileHandleForReading.readabilityHandler = { _ = $0.availableData }
  }

  deinit {
    sshd.terminate()
    _ = try? sh("tmux -L \(socket) kill-server")
    try? FileManager.default.removeItem(at: dir)
  }

  func connect(via jump: SSHConnection? = nil, trusting trusted: String? = nil) async throws -> SSHConnection {
    let trusted = trusted ?? hostKey
    return try await SSHConnection.connect(target, auth: [.key(key)], via: jump) { _, key in key == trusted }
  }
}

@discardableResult
private func sh(_ command: String) throws -> String {
  let process = Process(), out = Pipe()
  process.executableURL = URL(fileURLWithPath: "/bin/sh")
  process.arguments = ["-c", command]
  process.standardOutput = out
  process.standardError = FileHandle(forWritingAtPath: "/dev/null")
  try process.run()
  let data = out.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard process.terminationStatus == 0 else { throw KunaError("\(command): \(process.terminationStatus)") }
  return String(decoding: data, as: UTF8.self)
}

private func freePort() throws -> Int {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  defer { close(fd) }
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let bound = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0 } }
  guard bound else { throw KunaError("no free port") }
  return Int(UInt16(bigEndian: address.sin_port))
}

@Suite(.serialized) struct SSHTests {
  let server: TestServer
  init() throws { server = try TestServer() }

  @Test func runsCommandsWithTheirOutputErrorsAndExitCode() async throws {
    let connection = try await server.connect()
    defer { connection.close() }
    let result = try await connection.run("echo hi; echo oops >&2; exit 3")
    #expect(result.code == 3)
    #expect(result.text == "hi\n")
    #expect(result.stderr == "oops\n")
    // several commands at once on the one connection, one of them fed through stdin
    async let big = connection.run("cat", stdin: Data(repeating: 0x61, count: 300_000))
    async let quick = connection.run("echo quick")
    #expect(try await big.stdout.count == 300_000)
    #expect(try await quick.text == "quick\n")
  }

  @Test func stopsACommandThatTakesTooLong() async throws {
    let connection = try await server.connect()
    defer { connection.close() }
    let start = Date()
    #expect(try await connection.run("sleep 30", timeout: 1).code == 124)
    // without waiting for the host, which keeps the channel until the command ends
    #expect(Date().timeIntervalSince(start) < 5)
  }

  @Test func refusesAHostWhoseKeyIsNotTheTrustedOne() async throws {
    await #expect(throws: KunaError.self) { _ = try await server.connect(trusting: "ssh-ed25519 AAAAsomeoneelse") }
  }

  @Test func saysWhatTheHostTakesWhenSignInIsRefused() async throws {
    let error = await #expect(throws: KunaError.self) {
      _ = try await SSHConnection.connect(server.target, auth: [.key(NIOSSHPrivateKey(ed25519Key: .init())), .password("no")]) { _, _ in true }
    }
    #expect(error?.message.contains("the host takes a key") == true)
  }

  @Test func reachesAHostThroughAJumpHost() async throws {
    let jump = try await server.connect()
    let connection = try await server.connect(via: jump)
    defer { jump.close() }
    #expect(try await connection.run("echo through").text == "through\n")
    // a stream is cut by dropping it
    var lines = 0
    for try await _ in connection.stream("while :; do echo tick; sleep 0.1; done") {
      lines += 1
      if lines == 3 { break }
    }
    #expect(lines == 3)
  }

  @Test func installsTheHelperAndFollowsTheHost() async throws {
    guard (try? sh("command -v tmux")) != nil else { return }
    let connection = try await server.connect()
    defer { connection.close() }
    let shared = try Shared()
    var seen: [String] = []
    for try await event in watch(host: "test", on: connection, shared: shared) {
      switch event {
      case .installing: seen.append("installing")
      case .ready: seen.append("ready")
      case .agents(let agents):
        #expect(agents.isEmpty)
        seen.append("agents")
      }
      if seen.last == "agents" { break }
    }
    #expect(seen == ["installing", "ready", "agents"])
    #expect(try await kuna(["version"], on: connection).text == shared.version + "\n")
  }
}

@Test func sharedLogicTurnsAFrameIntoAgents() throws {
  let lines = [
    "P\t1\tkuna_ab12\t0\t1700000100\t1700000000\t0\tnode\t1\t✳ Fix tests",
    "A\tab12\t1700000050\t2048\t\t/h/.claude/projects/x/s.jsonl\t1700000090\tPreToolUse\tBash\t\tauto\t",
    "M\tab12\t{\"cwd\":\"/work\",\"folderId\":\"f1\",\"createdAt\":1700000000,\"prompt\":\"hi\"}",
    "P\t2\tkuna_q1\t0\t1700000100\t1700000000\t0\tclaude\t0\t",
  ]
  let agents = try Shared().agents(host: "cluster1", lines: lines, now: 1_700_000_101, offset: 100)
  #expect(agents.map(\.status) == ["working", "waiting"])
  #expect(agents[0].key == "cluster1::ab12")
  #expect(agents[0].attnTs == 1_699_999_950)
  #expect(agents[0].paneTitle == "✳ Fix tests")
}

@Test func quotesArgumentsForTheRemoteShell() {
  #expect(shq("plain/path-1.txt") == "plain/path-1.txt")
  #expect(shq("it's here") == #"'it'\''s here'"#)
}
