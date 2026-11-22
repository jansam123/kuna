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
  // one tmux server per test server: two suites run at once, each with its own HOME
  let socket = "kuna-ios-test-\(UUID().uuidString.prefix(8))"
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
    _ = try? sh("tmux -L \(socket) kill-server; rm -f \"${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/\(socket)\"")
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
    let shared = Shared.main
    var seen: [String] = []
    var listed: [Agent] = []
    for try await event in watch(host: "test", on: connection, shared: shared) {
      switch event {
      case .installing: seen.append("installing")
      case .ready: seen.append("ready")
      case .agents(let agents, _):
        listed = agents
        if seen.last == "agents" { break }
        #expect(agents.isEmpty)
        seen.append("agents")
        // sshd gives the session no LANG, as hosts do for a client that sends none: the frame must still parse
        let b64 = { (text: String) in Data(text.utf8).base64EncodedString() }
        let meta = #"{"cwd":"~","createdAt":1,"prompt":"Fit the signal region"}"#
        #expect(try await kuna(["spawn", "abc123", b64("~"), b64("sleep 60"), "100", "30", b64(meta), b64("")], on: connection).text == "ok\n")
      }
      // a report made between the agent's folder and its tmux session lists it, not running yet
      if listed.first?.alive == true { break }
    }
    #expect(seen == ["installing", "ready", "agents"])
    #expect(listed.map(\.key) == ["test::abc123"])
    #expect(listed.first?.title == "Fit the signal region")
    #expect(listed.first?.alive == true)
    #expect(try await kuna(["version"], on: connection).text == shared.version + "\n")
  }
}

/// The app's model against the throwaway sshd: what the screens do, without the screens.
@MainActor @Suite(.serialized) struct ModelTests {
  let server = try! TestServer()

  let saved = FileManager.default.temporaryDirectory.appendingPathComponent("kuna-ios-state-\(UUID().uuidString.prefix(8)).json")

  func model() throws -> AppModel {
    let model = AppModel(file: saved, key: server.key)
    try FileManager.default.createDirectory(at: server.dir.appendingPathComponent("home/work"), withIntermediateDirectories: true)
    model.update { state in
      state.hosts = [Host(alias: "gate", hostName: "127.0.0.1", user: NSUserName(), port: server.port), Host(alias: "test", hostName: "127.0.0.1", user: NSUserName(), port: server.port, jump: "gate")]
      state.hostKeys = [server.target.knownHostsName: [server.hostKey]]
      var project = Project(id: "p1", name: "Analysis", host: "test", color: "#4d8dff", agentCommand: "cat")
      project.folders = [Folder(id: "f1", path: "~/work", name: "work", color: "#ff9f1c")]
      state.projects = [project]
    }
    return model
  }

  func until(_ what: String, seconds: Double = 15, _ check: () -> Bool) async throws {
    let start = Date()
    while !check() {
      guard Date().timeIntervalSince(start) < seconds else { throw KunaError("waited \(seconds)s for: \(what)") }
      try await Task.sleep(for: .milliseconds(100))
    }
  }

  @Test func connectsThroughAJumpStartsTypesReadsAndStops() async throws {
    guard (try? sh("command -v tmux")) != nil else { return }
    let model = try model()
    defer { model.disconnect() }
    model.becomeActive()
    try await until("the host to be ready") { model.links["test"]?.synced == true }
    #expect(model.links["test"]?.phase == .ready)
    #expect(model.links["gate"] == nil)  // a host only jumped through is not watched

    let project = model.state.projects[0]
    let key = try await model.spawn(project: project, folder: project.folders[0], prompt: "")
    #expect(model.agent(key)?.status == "starting")
    try await until("the agent in a report from the host (\(String(describing: model.links["test"]?.phase)))") { model.links["test"]?.agents.contains { $0.key == key } == true }
    try await until("the agent in its folder: \(model.tree.map { $0.folders.map { "\($0.folder.id)=\($0.agents.map(\.key))" } })") { model.tree.first?.folders.first?.agents.contains { $0.key == key } == true }
    // a report made between the agent's folder and its tmux session lists it, not running yet
    try await until("the agent to be running") { model.links["test"]?.agents.first { $0.key == key }?.alive == true }
    let agent = try #require(model.agent(key))
    #expect(!agent.isBackground)
    #expect(model.place(of: key)?.folder.id == "f1")
    model.rename(key, to: " Fit ")
    #expect(model.name(of: agent) == "Fit")

    // typed into it through tmux
    let session = AgentSession(key: key, model: model)
    try await session.send("hello from the phone")
    #expect(session.outbox.map(\.text) == ["hello from the phone"])
    try await until("the typed line on its screen") { (try? sh("tmux -L \(server.socket) capture-pane -p -t kuna_\(agent.agentId)"))?.contains("hello from the phone") == true }

    // its conversation, once a hook has said where the transcript is
    let transcript = server.dir.appendingPathComponent("home/work/t.jsonl").path
    let first = #"{"type":"user","uuid":"u1","message":{"content":"Fit the signal region"}}"# + "\n"
    try first.write(toFile: transcript, atomically: true, encoding: .utf8)
    let hook = #"{"hook_event_name":"Stop","transcript_path":"\#(transcript)"}"#
    let ran = try await model.run("test", ["version"])
    #expect(ran.code == 0)
    let connection = try await server.connect()
    defer { connection.close() }
    #expect(try await connection.run("KUNA_AGENT_ID=\(agent.agentId) sh .kuna/bin/kuna hook", stdin: Data(hook.utf8)).code == 0)
    try await until("the transcript's path in a frame") { model.agent(key)?.transcriptPath == transcript }
    await session.pull()
    #expect(session.items.map(\.text) == ["Fit the signal region"])
    // a reply cut in the middle of a character is finished by the next read
    let reply = #"{"type":"assistant","uuid":"a1","message":{"model":"claude-x","content":[{"type":"text","text":"Fertig – plots/mass.png"}]}}"# + "\n"
    let bytes = Data(reply.utf8)
    let cut = bytes.firstIndex(of: 0xE2)! + 1
    let handle = try #require(FileHandle(forWritingAtPath: transcript))
    try handle.seekToEnd()
    try handle.write(contentsOf: bytes[..<cut])
    await session.pull()
    #expect(session.items.count == 1)
    try handle.write(contentsOf: bytes[cut...])
    try handle.close()
    await session.pull()
    #expect(session.items.map(\.kind) == ["user", "assistant"])
    #expect(session.items.last?.text == "Fertig – plots/mass.png")
    #expect(session.mentionedFiles() == [server.dir.appendingPathComponent("home/work/plots/mass.png").path].map { _ in "~/work/plots/mass.png" })

    // its own screen
    try await session.attach()
    try await until("the terminal to draw") { String(decoding: session.drawnSoFar, as: UTF8.self).contains("hello from the phone") }
    session.write("typed in the terminal\r")
    try await until("the terminal's echo") { String(decoding: session.drawnSoFar, as: UTF8.self).contains("typed in the terminal") }
    session.close()

    try await model.stop(agent)
    try await until("the agent to be gone") { model.links["test"]?.agents.contains { $0.key == key } == false && model.links["test"]?.synced == true }
    #expect((try? sh("tmux -L \(server.socket) has-session -t kuna_\(agent.agentId)")) == nil)
  }

  @Test func refusesAHostWhoseKeyChangedAndDoesNotRetry() async throws {
    let model = try model()
    defer { model.disconnect() }
    model.update { $0.hostKeys = [server.target.knownHostsName: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKeyOther"]] }
    model.becomeActive()
    try await until("the refusal") { if case .failed(_, final: true) = model.links["test"]?.phase { true } else { false } }
    guard case .failed(let why, _) = model.links["test"]?.phase else { return }
    #expect(why.contains("another host key"))
    #expect(model.question == nil)
  }

  @Test func asksAboutAHostItNeverSawAndRemembersTheAnswer() async throws {
    let model = try model()
    defer { model.disconnect() }
    model.update { $0.hostKeys = [:] }
    model.becomeActive()
    try await until("the question") { model.question != nil }
    let question = try #require(model.question)
    #expect(question.fingerprint.hasPrefix("SHA256:"))
    model.answer(question, true)
    try await until("the host to be ready") { model.links["test"]?.synced == true }
    #expect(model.state.hostKeys[server.target.knownHostsName] == [server.hostKey])
  }

  @Test func importsAnExportAndKeepsWhatWasMadeHere() async throws {
    let model = try model()
    let file = ##"{"kuna":"iphone","version":1,"exportedAt":7,"projects":[{"id":"m1","name":"From the Mac","host":"node1","color":"#2ee6c5","agentCommand":"claude","folders":[{"id":"mf","path":"~/ana","name":"ana","color":"#ffd166"}]}],"names":{"node1::ab12":"Fit"},"hidden":{},"theme":"muon","hosts":[{"alias":"node1","hostName":"node1.example.org","user":"ada","port":22,"jump":"door"},{"alias":"door","hostName":"gate.example.org","user":"ada","port":22}],"hostKeys":{"gate.example.org":["ssh-ed25519 AAAA"]}}"##
    #expect(try model.importFile(file) == "1 project on 2 hosts")
    #expect(model.state.projects.map(\.id) == ["m1", "p1"])
    #expect(model.state.hosts.map(\.alias) == ["node1", "door", "gate", "test"])
    #expect(model.theme.id == "muon")
    #expect(model.tree.map(\.project.name) == ["From the Mac", "Analysis"])
    #expect(throws: KunaError.self) { try model.importFile("{}") }
    // and it is all there after a restart
    let again = AppModel(file: saved, key: server.key)
    #expect(again.state == model.state)
  }
}

@Test func sharedLogicTurnsAFrameIntoAgents() throws {
  let lines = [
    "P\t1\tkuna_ab12\t0\t1700000100\t1700000000\t0\tnode\t1\t✳ Fix tests",
    "A\tab12\t1700000050\t2048\t\t/h/.claude/projects/x/s.jsonl\t1700000090\tPreToolUse\tBash\t\tauto\t",
    "M\tab12\t{\"cwd\":\"/work\",\"folderId\":\"f1\",\"createdAt\":1700000000,\"prompt\":\"hi\"}",
    "P\t2\tkuna_q1\t0\t1700000100\t1700000000\t0\tclaude\t0\t",
  ]
  let agents = try Shared.main.agents(host: "cluster1", lines: lines, now: 1_700_000_101, offset: 100)
  #expect(agents.map(\.status) == ["working", "waiting"])
  #expect(agents[0].key == "cluster1::ab12")
  #expect(agents[0].attnTs == 1_699_999_950)
  #expect(agents.map(\.title) == ["hi", "agent q1"])
}

@Test func quotesArgumentsForTheRemoteShell() {
  #expect(shq("plain/path-1.txt") == "plain/path-1.txt")
  #expect(shq("it's here") == #"'it'\''s here'"#)
}
