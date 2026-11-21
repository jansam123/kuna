import KunaCore
import SwiftUI

/// Kuna's colours (docs/THEMES.md, Cherenkov): the status colours are the same in every scheme.
enum Look {
  static let ground = Color(red: 0x05 / 255, green: 0x07 / 255, blue: 0x0c / 255)
  static let panel = Color(red: 0x09 / 255, green: 0x0c / 255, blue: 0x14 / 255)
  static let raised = Color(red: 0x0f / 255, green: 0x14 / 255, blue: 0x20 / 255)
  static let text = Color(red: 0xdf / 255, green: 0xe6 / 255, blue: 0xf5 / 255)
  static let muted = Color(red: 0x8b / 255, green: 0x96 / 255, blue: 0xad / 255)
  static let working = Color(red: 0x4d / 255, green: 0x8d / 255, blue: 1)
  static let needsYou = Color(red: 1, green: 0xb5 / 255, blue: 0x47 / 255)
  static let idle = Color(red: 0x6b / 255, green: 0x74 / 255, blue: 0x88 / 255)
  static let failed = Color(red: 1, green: 0x5a / 255, blue: 0x6e / 255)
  static let stopped = Color(red: 0x3a / 255, green: 0x41 / 255, blue: 0x52 / 255)
}

public struct RootView: View {
  @State private var model = AppModel()
  @State private var editing = false
  @Environment(\.scenePhase) private var scene

  public init() {}

  public var body: some View {
    NavigationStack {
      AgentsView(model: model, edit: { editing = true })
        .navigationTitle(model.host.hop.filled ? model.host.title : "Kuna")
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button("Host", systemImage: "server.rack") { editing = true }
          }
        }
    }
    .tint(Look.working)
    .preferredColorScheme(.dark)
    .sheet(isPresented: $editing) { HostForm(model: model) }
    .alert("Trust this host?", isPresented: .constant(model.question != nil), presenting: model.question) { question in
      Button("Trust") { answer(question, true) }
      Button("Don't connect", role: .cancel) { answer(question, false) }
    } message: { question in
      Text("This phone has not connected to \(question.host) before. Its key is\n\(question.fingerprint)\n\nOn your Mac, `ssh-keygen -lF \(question.host)` shows the key your Mac trusts.")
    }
    .onChange(of: scene, initial: true) { _, now in
      if now == .active { model.resume() }
    }
  }

  private func answer(_ question: HostKeyQuestion, _ yes: Bool) {
    model.question = nil
    question.answer(yes)
  }
}

struct AgentsView: View {
  let model: AppModel
  let edit: () -> Void

  var body: some View {
    List {
      Section {
        status
      }
      .listRowBackground(Look.panel)
      if model.connected {
        Section(model.agents.isEmpty ? "No agents on this host" : "Agents") {
          ForEach(model.agents.sorted { rank($0) < rank($1) }) { agent in
            AgentRow(agent: agent)
          }
        }
        .listRowBackground(Look.panel)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Look.ground)
    .foregroundStyle(Look.text)
    .animation(.default, value: model.agents)
  }

  /// those that need you first, then the busy ones
  private func rank(_ agent: Agent) -> Int {
    ["waiting": 0, "working": 1, "starting": 1, "background": 2, "failed": 3, "idle": 4][agent.status] ?? 5
  }

  @ViewBuilder private var status: some View {
    switch model.phase {
    case .idle:
      if model.host.hop.filled {
        Button("Connect") { model.connect() }
      } else {
        Button("Set up a host", action: edit)
      }
    case .connecting:
      Label { Text("Signing in…") } icon: { ProgressView() }
    case .installing:
      Label { Text("Installing Kuna's helper on the host…") } icon: { ProgressView() }
    case .ready(let hostname, let claude):
      Label(claude ? "Connected to \(hostname)" : "Connected to \(hostname). Claude Code was not found there.", systemImage: "checkmark.circle.fill")
        .foregroundStyle(claude ? Look.muted : Look.needsYou)
    case .failed(let why):
      VStack(alignment: .leading, spacing: 10) {
        Text(why).foregroundStyle(Look.failed)
        Button("Try again") { model.connect() }
      }
    }
  }
}

struct AgentRow: View {
  let agent: Agent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      StatusDot(status: agent.status)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).lineLimit(2)
        Text(line).font(.footnote).foregroundStyle(agent.status == "waiting" ? Look.needsYou : Look.muted).lineLimit(2)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title), \(word)")
  }

  private var title: String {
    let named = [agent.name, agent.paneTitle?.trimmingCharacters(in: CharacterSet(charactersIn: "✳⠂⠐ ")), agent.prompt].compactMap { $0 }.first { !$0.isEmpty }
    return named ?? agent.key
  }

  private var word: String {
    ["waiting": "needs you", "working": "working", "starting": "starting", "background": "waiting on a job", "idle": "idle", "failed": "failed", "exited": "stopped"][agent.status] ?? agent.status
  }

  private var line: String {
    let doing = agent.status == "waiting" ? agent.needs : agent.detail ?? agent.tool
    let folder = agent.cwd.split(separator: "/").last.map(String.init) ?? agent.cwd
    return [doing ?? word, folder].filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

/// As on the Mac: filled for working, needs you, idle and failed; a ring for stopped and for waiting on a job.
struct StatusDot: View {
  let status: String

  var body: some View {
    let color: Color = switch status {
    case "working", "starting", "background": Look.working
    case "waiting": Look.needsYou
    case "failed": Look.failed
    case "exited": Look.stopped
    default: Look.idle
    }
    let ring = status == "background" || status == "exited"
    Circle()
      .strokeBorder(color, lineWidth: 2)
      .background(Circle().fill(ring ? .clear : color))
      .frame(width: 10, height: 10)
      .accessibilityHidden(true)
  }
}

struct HostForm: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var jumpPassword = ""

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name (optional)", text: $model.host.name).plain()
        }
        HopFields(title: "Host", hop: $model.host.hop, password: $password)
        Section {
          Toggle("Through a jump host", isOn: $model.host.usesJump)
        } footer: {
          Text("What ProxyJump is in your ssh config.")
        }
        if model.host.usesJump {
          HopFields(title: "Jump host", hop: $model.host.jump, password: $jumpPassword)
        }
        Section {
          Text(model.publicKey).font(.caption.monospaced()).textSelection(.enabled)
          ShareLink("Send the key to your Mac", item: model.publicKey)
        } header: {
          Text("This phone's key")
        } footer: {
          Text("Add this line to ~/.ssh/authorized_keys on each host that takes keys, the jump host too. The private half never leaves this phone.")
        }
      }
      .navigationTitle("Host")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Connect") {
            model.setPassword(model.host.hop, password)
            model.setPassword(model.host.jump, jumpPassword)
            dismiss()
            model.connect()
          }
          .disabled(!model.host.hop.filled || (model.host.usesJump && !model.host.jump.filled))
        }
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .onAppear {
        password = model.password(model.host.hop)
        jumpPassword = model.password(model.host.jump)
      }
    }
    .preferredColorScheme(.dark)
  }
}

struct HopFields: View {
  let title: String
  @Binding var hop: Hop
  @Binding var password: String

  var body: some View {
    Section {
      TextField("Address", text: $hop.address).plain()
      TextField("User", text: $hop.user).plain()
      TextField("Port", value: $hop.port, format: .number.grouping(.never))
      SecureField("Password (empty: the phone's key)", text: $password)
    } header: {
      Text(title)
    }
  }
}

extension View {
  /// host names and user names: no capitals, no autocorrect
  func plain() -> some View {
    #if os(iOS)
      return self.textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
    #else
      return self.autocorrectionDisabled()
    #endif
  }
}
