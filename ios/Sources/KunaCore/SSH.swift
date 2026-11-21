import CryptoKit
import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/// Where to sign in: one hop of what `~/.ssh/config` calls HostName, Port and User.
public struct SSHTarget: Codable, Hashable, Sendable {
  public var host: String
  public var port: Int
  public var user: String
  public init(host: String, port: Int = 22, user: String) {
    self.host = host
    self.port = port
    self.user = user
  }
  /// the name its host key is remembered under, as in known_hosts
  public var knownHostsName: String { port == 22 ? host : "[\(host)]:\(port)" }
}

public enum SSHAuth: @unchecked Sendable {
  case key(NIOSSHPrivateKey)
  case password(String)
}

/// Decides whether a host's key (`ssh-ed25519 AAAA…`) is the one to trust; may ask the user.
public typealias HostKeyCheck = @Sendable (_ knownHostsName: String, _ openSSHKey: String) async -> Bool

public struct ExecResult: Sendable {
  public var code: Int
  public var stdout: Data
  public var stderr: String
  public var text: String { String(decoding: stdout, as: UTF8.self) }
}

/// One ssh connection, direct or through another one (ProxyJump), carrying any number of commands.
public final class SSHConnection: @unchecked Sendable {
  // shortcut: BSD sockets on one thread; move to NIOTransportServices if a network change (Wi-Fi to mobile) should not cost the connection
  private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
  private let channel: Channel
  /// the connection this one travels through: kept open for as long as this one lives
  private let jump: SSHConnection?

  private init(channel: Channel, jump: SSHConnection?) {
    self.channel = channel
    self.jump = jump
  }

  /// `auth` is tried in order, each only if the host offers that method.
  public static func connect(_ target: SSHTarget, auth: [SSHAuth], via jump: SSHConnection? = nil, hostKey: @escaping HostKeyCheck) async throws -> SSHConnection {
    let group = jump?.channel.eventLoop ?? Self.group.next()
    let signedIn = group.makePromise(of: Void.self)
    let handlers: @Sendable (Channel) throws -> Void = { channel in
      let ssh = NIOSSHHandler(
        role: .client(.init(userAuthDelegate: Offers(user: target.user, left: auth), serverAuthDelegate: HostKey(name: target.knownHostsName, check: hostKey))),
        allocator: channel.allocator,
        inboundChildChannelInitializer: nil
      )
      try channel.pipeline.syncOperations.addHandlers([ssh, SignIn(done: signedIn)])
    }
    let channel: Channel
    do {
      if let jump {
        // ProxyJump: a tunnel through the first connection carries the second
        let origin = try SocketAddress(ipAddress: "127.0.0.1", port: 0)
        channel = try await jump.open(.directTCPIP(.init(targetHost: target.host, targetPort: target.port, originatorAddress: origin))) { tunnel in
          try tunnel.pipeline.syncOperations.addHandler(Tunnel())
          try handlers(tunnel)
        }
      } else {
        channel = try await ClientBootstrap(group: group)
          .connectTimeout(.seconds(20))
          .channelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
          .channelInitializer { channel in channel.eventLoop.makeCompletedFuture { try handlers(channel) } }
          .connect(host: target.host, port: target.port).get()
      }
    } catch {
      signedIn.fail(error)
      throw KunaError("Could not reach \(target.host): \(describe(error))")
    }
    do {
      try await signedIn.futureResult.get()
    } catch {
      channel.close(promise: nil)
      throw error is KunaError ? error : KunaError("\(target.host): \(describe(error))")
    }
    return SSHConnection(channel: channel, jump: jump)
  }

  public func close() {
    channel.close(promise: nil)
  }

  public var isOpen: Bool { channel.isActive }

  /// Run a command to its end. `stdin` is sent and closed, as `ssh host cmd < file`.
  public func run(_ command: String, stdin: Data? = nil, timeout: TimeInterval = 30) async throws -> ExecResult {
    var out = Data()
    let exec = Exec(command: command, stdin: stdin) { out.append($0) }
    let session = try await open(.session) { try $0.pipeline.syncOperations.addHandler(exec) }
    let late = session.eventLoop.scheduleTask(in: .milliseconds(Int64(timeout * 1000))) {
      // answer now: sshd keeps the channel open until the command ends, however long that is
      exec.stderr += "\n[kuna] timed out"
      exec.end(124)
      session.close(promise: nil)
    }
    defer { late.cancel() }
    let code = try await exec.done.futureResult.get()
    return ExecResult(code: code, stdout: out, stderr: exec.stderr)
  }

  /// A command's output as it arrives, until it ends or the stream is dropped (which closes its channel).
  public func stream(_ command: String) -> AsyncThrowingStream<Data, Error> {
    AsyncThrowingStream { continuation in
      let exec = Exec(command: command, stdin: nil) { continuation.yield($0) }
      let task = Task {
        do {
          let session = try await self.open(.session) { try $0.pipeline.syncOperations.addHandler(exec) }
          continuation.onTermination = { _ in session.close(promise: nil) }
          let code = try await exec.done.futureResult.get()
          continuation.finish(throwing: code == 0 ? nil : KunaError(exec.stderr.isEmpty ? "The command ended (\(code))." : exec.stderr))
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private func open(_ type: SSHChannelType, _ setUp: @escaping @Sendable (Channel) throws -> Void) async throws -> Channel {
    let opened = channel.eventLoop.makePromise(of: Channel.self)
    channel.eventLoop.execute { [channel] in
      do {
        try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self).createChannel(opened, channelType: type) { child, _ in
          child.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).flatMapThrowing { try setUp(child) }
        }
      } catch {
        opened.fail(error)
      }
    }
    return try await opened.futureResult.get()
  }
}

/// A new key for this device, as text for `authorized_keys`.
public func openSSHPublicKey(_ key: NIOSSHPrivateKey, comment: String) -> String {
  "\(String(openSSHPublicKey: key.publicKey)) \(comment)"
}

/// Quote an argument for a remote POSIX-ish shell (as `shq` in src/main/hosts/exec.ts).
public func shq(_ arg: String) -> String {
  arg.range(of: #"^[\w@%+=:,./-]+$"#, options: .regularExpression) != nil ? arg : "'\(arg.replacingOccurrences(of: "'", with: #"'\''"#))'"
}

private func describe(_ error: Error) -> String {
  if let error = error as? KunaError { return error.message }
  if let error = error as? NIOConnectionError { return error.connectionErrors.first.map { "\($0.error)" } ?? "the address could not be found" }
  return "\(error)"
}

// ------------------------------------------------------------ handlers ----

/// Offers each way of signing in once, in order; none left means the host refused them all.
private final class Offers: NIOSSHClientUserAuthenticationDelegate {
  let user: String
  var left: [SSHAuth]
  init(user: String, left: [SSHAuth]) {
    self.user = user
    self.left = left
  }

  func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
    while !left.isEmpty {
      switch left.removeFirst() {
      case .key(let key) where availableMethods.contains(.publicKey):
        return nextChallengePromise.succeed(.init(username: user, serviceName: "", offer: .privateKey(.init(privateKey: key))))
      case .password(let password) where availableMethods.contains(.password):
        return nextChallengePromise.succeed(.init(username: user, serviceName: "", offer: .password(.init(password: password))))
      default:
        continue
      }
    }
    // what the host would still take, for the message: a typed prompt (keyboard-interactive) is the one this library cannot answer
    var wants: [String] = []
    if availableMethods.contains(.publicKey) { wants.append("a key") }
    if availableMethods.contains(.password) { wants.append("a password") }
    nextChallengePromise.fail(KunaError("sign-in refused for \(user)" + (wants.isEmpty ? "; the host takes neither a key nor a plain password" : "; the host takes \(wants.joined(separator: " or "))")))
  }
}

private final class HostKey: NIOSSHClientServerAuthenticationDelegate {
  let name: String
  let check: HostKeyCheck
  init(name: String, check: @escaping HostKeyCheck) {
    self.name = name
    self.check = check
  }

  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    let key = String(openSSHPublicKey: hostKey)
    validationCompletePromise.completeWithTask { [name, check] in
      guard await check(name, key) else { throw KunaError("its host key is not trusted") }
    }
  }
}

/// Tells `connect` when the sign-in went through, or why the connection ended before it did.
private final class SignIn: ChannelInboundHandler {
  typealias InboundIn = Any
  let done: EventLoopPromise<Void>
  var error: Error?
  init(done: EventLoopPromise<Void>) { self.done = done }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if event is UserAuthSuccessEvent { done.succeed() }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if self.error == nil { self.error = error }
    done.fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    done.fail(error ?? KunaError("the connection closed"))
    context.fireChannelInactive()
  }
}

/// A tunnel's channel speaks in ssh channel data; the ssh connection inside it wants plain bytes.
private final class Tunnel: ChannelDuplexHandler {
  typealias InboundIn = SSHChannelData
  typealias InboundOut = ByteBuffer
  typealias OutboundIn = ByteBuffer
  typealias OutboundOut = SSHChannelData

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let data = unwrapInboundIn(data)
    if case .channel = data.type, case .byteBuffer(let bytes) = data.data { context.fireChannelRead(wrapInboundOut(bytes)) }
  }

  func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
    context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(unwrapOutboundIn(data)))), promise: promise)
  }
}

/// One command on a session channel: its output as it comes, its exit code at the end.
private final class Exec: ChannelDuplexHandler, @unchecked Sendable {
  typealias InboundIn = SSHChannelData
  typealias OutboundIn = Never
  typealias OutboundOut = SSHChannelData

  let command: String
  let stdin: Data?
  let output: (Data) -> Void
  private(set) var done: EventLoopPromise<Int>!
  var stderr = ""
  private var code: Int?
  private var ended = false

  init(command: String, stdin: Data?, output: @escaping (Data) -> Void) {
    self.command = command
    self.stdin = stdin
    self.output = output
  }

  func handlerAdded(context: ChannelHandlerContext) {
    done = context.eventLoop.makePromise(of: Int.self)
  }

  func channelActive(context: ChannelHandlerContext) {
    context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)).whenFailure { error in
      self.fail(error)
      context.close(promise: nil)
    }
    if let stdin, !stdin.isEmpty {
      context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(context.channel.allocator.buffer(bytes: stdin)))), promise: nil)
    }
    // no more input, as `ssh host cmd < /dev/null`: a command that reads stdin must not wait for the phone
    context.close(mode: .output, promise: nil)
    context.fireChannelActive()
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let data = unwrapInboundIn(data)
    guard case .byteBuffer(let bytes) = data.data else { return }
    switch data.type {
    case .channel: output(Data(bytes.readableBytesView))
    case .stdErr: if stderr.utf8.count < 20_000 { stderr += String(buffer: bytes) }
    default: break
    }
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let status = event as? SSHChannelRequestEvent.ExitStatus { code = status.exitStatus }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    // 255 as ssh, when the connection went before the command ended
    end(code ?? 255)
    context.fireChannelInactive()
  }

  /// The first end counts: the exit code, a timeout (124, as timeout(1)) or an error.
  func end(_ code: Int) {
    if !ended { done.succeed(code) }
    ended = true
  }

  private func fail(_ error: Error) {
    if !ended { done.fail(error) }
    ended = true
  }
}
