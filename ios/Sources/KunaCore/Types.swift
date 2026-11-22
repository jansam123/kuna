import Foundation

// The same shapes as src/shared/types.ts and src/shared/phone.ts: what the Mac exports is what the
// phone keeps. Fields the phone has no use for are dropped when it saves.

public struct Folder: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  /// on the project's host; may start with `~`
  public var path: String
  /// the same folder with symlinks resolved, as agents report it
  public var real: String?
  /// agents placed here by hand on the Mac, in their order
  public var agents: [String]?
  public var name: String
  public var color: String
  public var collapsed: Bool?

  public init(id: String = UUID().uuidString, path: String, name: String, color: String) {
    self.id = id
    self.path = path
    self.name = name
    self.color = color
  }
}

public struct Project: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  /// a host's alias
  public var host: String
  public var color: String
  /// a short text for its block (μ, H, an emoji), or the name of one of the Mac's drawn icons
  public var icon: String?
  /// what starts a new agent, e.g. `claude` or `claude --model opus`
  public var agentCommand: String
  /// `background` (Claude Code's own sessions, the default for claude) or `tmux`
  public var launch: String?
  public var folders: [Folder]
  public var collapsed: Bool?
  public var otherCollapsed: Bool?

  public init(id: String = UUID().uuidString, name: String, host: String, color: String, agentCommand: String = "claude", folders: [Folder] = []) {
    self.id = id
    self.name = name
    self.host = host
    self.color = color
    self.agentCommand = agentCommand
    self.folders = folders
  }

  /// What its block shows: its icon when that is a letter or two (the Mac's drawn icons are
  /// not on the phone), else the name's first letter.
  public var glyph: String {
    if let icon, !icon.isEmpty, icon.count <= 2 { return icon }
    return name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
  }

  /// whether new agents are Claude Code (they get a session id, hooks and a transcript)
  public var startsClaude: Bool {
    let base = agentCommand.trimmingCharacters(in: .whitespaces)
    return base.isEmpty || base.range(of: #"(^|/)claude(\s|$)"#, options: .regularExpression) != nil
  }
}

/// A host as the phone signs in to it (`PhoneHost` in src/shared/phone.ts).
public struct Host: Codable, Identifiable, Hashable, Sendable {
  /// the alias in the Mac's ~/.ssh/config: the host's name in projects and agent keys
  public var alias: String
  public var hostName: String
  public var user: String
  public var port: Int
  /// the alias of the host it is reached through (ProxyJump)
  public var jump: String?
  public var keyName: String?
  public var id: String { alias }

  public init(alias: String = "", hostName: String = "", user: String = "", port: Int = 22, jump: String? = nil) {
    self.alias = alias
    self.hostName = hostName
    self.user = user
    self.port = port
    self.jump = jump
  }

  public var target: SSHTarget {
    SSHTarget(host: hostName.trimmingCharacters(in: .whitespaces), port: port, user: user.trimmingCharacters(in: .whitespaces), keyName: keyName)
  }
  /// where its password is kept in the keychain
  public var passwordAccount: String { "password:\(target.user)@\(target.knownHostsName)" }
}

/// Everything the app keeps (`PhoneState` in src/shared/phone.ts).
public struct PhoneState: Codable, Equatable, Sendable {
  public struct FromMac: Codable, Equatable, Sendable {
    public var projects: [String] = []
    public var hosts: [String] = []
  }
  public var projects: [Project] = []
  public var names: [String: String] = [:]
  public var hidden: [String: Double] = [:]
  public var theme = "cherenkov"
  public var hosts: [Host] = []
  public var hostKeys: [String: [String]] = [:]
  public var fromMac = FromMac()
  public var themeChosen: Bool?
  public var importedAt: Double?
  public init() {}
}

public struct Question: Codable, Hashable, Sendable {
  public var question: String
  public var options: [String]
}

public struct ContextInfo: Codable, Hashable, Sendable {
  public var tokens: Double
  public var window: Double
  public var pct: Double
  public var level: String
}

/// An agent as the host's watch stream reports it (`AgentRuntime`), with the words the shared code made for it.
public struct Agent: Codable, Identifiable, Hashable, Sendable {
  public var key: String
  /// its id on the host: Kuna's hex id, or `cc-<id>` for a Claude Code background session
  public var agentId: String
  /// `tmux` (started by Kuna) or `claude` (a background session)
  public var kind: String
  public var host: String
  public var cwd: String
  public var worktree: String?
  public var status: String
  public var alive: Bool
  public var createdAt: Double
  public var attnTs: Double
  public var activityTs: Double
  public var projectId: String?
  public var folderId: String?
  public var sessionId: String?
  public var command: String?
  public var prompt: String?
  public var transcriptPath: String?
  public var transcriptSize: Double
  public var lastReply: String?
  public var questions: [Question]?
  public var permissionMode: String?
  /// what to call it, as the Mac does (`titleOf`), before a name given by hand
  public var title: String
  /// what it is doing, in words; what it waits for when it needs you
  public var doing: String
  public var needs: String?
  public var context: ContextInfo?
  public var modelName: String?

  public var id: String { key }
  /// a Claude Code background session: stopped and started with the claude CLI, typed into only through `claude attach`
  public var isBackground: Bool { agentId.hasPrefix("cc-") }
  /// the folder its files are in
  public var base: String { worktree ?? cwd }

  enum CodingKeys: String, CodingKey {
    case key, kind, host, cwd, worktree, status, alive, createdAt, attnTs, activityTs, projectId, folderId, sessionId, command, prompt
    case transcriptPath, transcriptSize, lastReply, questions, permissionMode, title, doing, needs, context, modelName
    case agentId = "id"
  }
}

/// One row of a conversation (`ChatItem` in src/shared/chat.ts).
public struct ChatItem: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  /// user, assistant, thinking, tool, question, note
  public var kind: String
  public var text: String
  public var tool: String?
  /// tool and question: running, done, error
  public var state: String?
  public var options: [String]?
  public var at: Double?

  public init(id: String, kind: String, text: String) {
    self.id = id
    self.kind = kind
    self.text = text
  }
}

public struct Todo: Codable, Hashable, Sendable {
  public var id: String
  public var content: String
  public var status: String
}

public struct ChatDetails: Codable, Hashable, Sendable {
  public var title: String?
  public var model: String?
  public var effort: String?
  public var permissionMode: String?
  public var gitBranch: String?
  public var todos: [Todo]?
  public var questions: [Question]?
  public var context: ContextInfo?
}

public struct ChatState: Codable, Sendable {
  public var items: [ChatItem]
  public var details: ChatDetails?
}

public struct MediaItem: Codable, Identifiable, Hashable, Sendable {
  public var path: String
  public var mtime: Double
  public var size: Double
  /// image, pdf, svg, md, html
  public var kind: String
  public var id: String { path }
  public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
  /// changes when the file is made again, so a new plot is never shown from the cache
  public var stamp: String { "\(Int(mtime)):\(Int(size))" }
}

/// A colour scheme (`Theme` in src/shared/themes.ts), without the terminal's ANSI table.
public struct Theme: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var blurb: String
  public var ground, panel, raised, line, text, dim, faint, accent, insert: String
  public var working, waiting, idle, exited, unread, danger: String
  public var terminal: [String: String]

  /// Cherenkov, for a build whose shared logic could not say (it always can)
  public static let fallback = Theme(
    id: "cherenkov", name: "Cherenkov", blurb: "", ground: "#05070c", panel: "#090c14", raised: "#0f1420", line: "#1a2133", text: "#dfe6f5", dim: "#8590a8", faint: "#4a5368",
    accent: "#4d8dff", insert: "#a78bff", working: "#4d8dff", waiting: "#ffb547", idle: "#6b7488", exited: "#3a4152", unread: "#6fe3ff", danger: "#ff5a6e", terminal: [:])
}
