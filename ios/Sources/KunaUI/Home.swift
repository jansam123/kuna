#if os(iOS)
import KunaCore
import SwiftUI
import UniformTypeIdentifiers

/// What the app opens with: every project, its folders and their agents, as the Mac's sidebar.
struct HomeView: View {
  let model: AppModel
  @Binding var path: [Route]
  @Binding var notice: Notice?
  @Environment(\.look) private var look
  @State private var settings = false
  @State private var editing: ProjectDraft?
  @State private var starting: StartIn?
  @State private var importing = false

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 18) {
        ForEach(troubled) { link in HostBanner(model: model, link: link, edit: { settings = true }) }
        if model.state.projects.isEmpty {
          Welcome(importing: $importing, new: { editing = ProjectDraft(model: model) })
        } else {
          let waiting = model.tree.flatMap(\.agents).filter { $0.status == "waiting" }
          if !waiting.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Needs you").font(.footnote.weight(.semibold)).foregroundStyle(look.waiting).padding(.horizontal, 6)
              VStack(spacing: 0) {
                ForEach(waiting) { agent in
                  AgentRow(model: model, agent: agent, open: { path.append(.agent(agent.key)) })
                  if agent.key != waiting.last?.key { Divider().overlay(look.line).padding(.leading, 38) }
                }
              }
              .card(look, padding: 0)
            }
          }
          ForEach(model.tree) { project in
            ProjectSection(
              model: model, tree: project, open: { path.append(.agent($0)) }, edit: { editing = ProjectDraft(model: model, project: project.project) },
              start: { starting = StartIn(project: project.project, folder: $0) })
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .background(look.ground)
    .refreshable {
      for link in model.links.values where !link.ready { model.reconnect(link.alias) }
      try? await Task.sleep(for: .milliseconds(600))
    }
    .navigationTitle("Kuna")
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Settings", systemImage: "gearshape") { settings = true }
      }
      ToolbarItem(placement: .primaryAction) {
        Menu("Add", systemImage: "plus") {
          Button("New project", systemImage: "folder.badge.plus") { editing = ProjectDraft(model: model) }
          Button("Import from the Mac", systemImage: "square.and.arrow.down") { importing = true }
        }
      }
    }
    .sheet(isPresented: $settings) { SettingsView(model: model, importing: $importing).environment(\.look, look) }
    .sheet(item: $editing) { draft in ProjectForm(model: model, draft: draft).environment(\.look, look) }
    .sheet(item: $starting) { place in
      NewAgentSheet(model: model, place: place) { key in path.append(.agent(key)) }.environment(\.look, look)
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .data, .item]) { result in
      guard case .success(let url) = result else { return }
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      do {
        notice = Notice(title: "Imported", text: "\(try model.importFile(try String(contentsOf: url, encoding: .utf8))) from your Mac.")
      } catch {
        notice = Notice(title: "Could not import", text: error.localizedDescription)
      }
    }
  }

  /// hosts that are not simply connected: said at the top, with what to do
  private var troubled: [HostLink] {
    model.links.values.filter { $0.phase != .ready }.sorted { $0.alias < $1.alias }
  }
}

struct StartIn: Identifiable {
  let project: Project
  let folder: Folder
  var id: String { project.id + folder.id }
}

private struct Welcome: View {
  @Binding var importing: Bool
  let new: () -> Void
  @Environment(\.look) private var look

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("No projects yet").font(.title3.weight(.semibold)).foregroundStyle(look.text)
      Text("On your Mac, choose Kuna ▸ Export for iPhone… and send the file here with AirDrop, or save it to Files. It brings your projects, folders and hosts. Passwords and keys stay on the Mac.")
        .font(.subheadline).foregroundStyle(look.dim)
      Button("Import from the Mac", systemImage: "square.and.arrow.down") { importing = true }.buttonStyle(.borderedProminent)
      Button("Set up a project by hand", systemImage: "folder.badge.plus", action: new).buttonStyle(.bordered)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(look, padding: 18)
  }
}

/// A host that is connecting, or could not be signed in to: what happened and what to do.
private struct HostBanner: View {
  let model: AppModel
  let link: HostLink
  let edit: () -> Void
  @Environment(\.look) private var look

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      switch link.phase {
      case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(look.danger)
      default: ProgressView().controlSize(.small)
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(link.alias).font(.subheadline.weight(.semibold)).foregroundStyle(look.text)
        Text(words).font(.footnote).foregroundStyle(look.dim).textSelection(.enabled)
        if case .failed = link.phase {
          HStack(spacing: 14) {
            Button("Try again") { model.reconnect(link.alias) }
            Button("Hosts", action: edit)
          }
          .font(.footnote.weight(.semibold))
          .padding(.top, 2)
        }
      }
      Spacer(minLength: 0)
    }
    .card(look)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("host-\(link.alias)")
  }

  private var words: String {
    switch link.phase {
    case .idle: "Not connected."
    case .connecting: "Signing in…"
    case .installing: "Installing Kuna's helper…"
    case .ready: "Connected."
    case .failed(let why, _):
      why.contains("sign-in refused") ? why + ". Add this phone's key to the host (Settings shows it), or save the host's password under Hosts." : why
    }
  }
}

private struct ProjectSection: View {
  let model: AppModel
  let tree: ProjectTree
  let open: (String) -> Void
  let edit: () -> Void
  let start: (Folder) -> Void
  @Environment(\.look) private var look

  var body: some View {
    let project = tree.project
    let folded = project.collapsed == true
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Button {
          model.update { state in
            if let i = state.projects.firstIndex(where: { $0.id == project.id }) { state.projects[i].collapsed = folded ? nil : true }
          }
        } label: {
          HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3).fill(Color(hex: project.color)).frame(width: 6, height: 22)
            VStack(alignment: .leading, spacing: 1) {
              Text(project.name).font(.title3.weight(.semibold)).foregroundStyle(look.text).lineLimit(1)
              HStack(spacing: 5) {
                StatusDot(status: hostStatus, size: 6)
                Text(hostWords).font(.caption).foregroundStyle(look.dim).lineLimit(1)
              }
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(look.faint).rotationEffect(.degrees(folded ? 0 : 90))
          }
        }
        .buttonStyle(.plain)
        Spacer(minLength: 0)
        Button("Edit \(project.name)", systemImage: "ellipsis.circle", action: edit).labelStyle(.iconOnly).foregroundStyle(look.dim)
      }
      .padding(.horizontal, 6)
      if !folded {
        if tree.folders.isEmpty {
          Button("Add a folder to start agents in", systemImage: "plus", action: edit).font(.subheadline).padding(.horizontal, 6)
        }
        ForEach(tree.folders) { folder in
          FolderCard(model: model, project: project, folder: folder, open: open, start: { start(folder.folder) })
        }
      }
    }
  }

  private var link: HostLink? { model.links[project.host] }
  private var project: Project { tree.project }
  private var hostStatus: String {
    switch link?.phase {
    case .ready: "idle"
    case .failed: "failed"
    case .connecting, .installing: "starting"
    default: "exited"
    }
  }
  private var hostWords: String {
    let count = tree.agents.filter(\.alive).count
    return count > 0 ? "\(project.host) · \(count) running" : project.host
  }
}

private struct FolderCard: View {
  let model: AppModel
  let project: Project
  let folder: FolderTree
  let open: (String) -> Void
  let start: () -> Void
  @Environment(\.look) private var look

  var body: some View {
    let folded = folder.folder.collapsed == true
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Button(action: toggle) {
          HStack(spacing: 8) {
            Image(systemName: folder.other ? "tray" : "folder.fill").font(.footnote).foregroundStyle(Color(hex: folder.folder.color))
            Text(folder.folder.name).font(.subheadline.weight(.semibold)).foregroundStyle(look.text).lineLimit(1)
            if folded, !folder.agents.isEmpty { Text("\(folder.agents.count)").font(.caption.monospacedDigit()).foregroundStyle(look.dim) }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !folder.other {
          Button("New agent in \(folder.folder.name)", systemImage: "plus.circle.fill", action: start)
            .labelStyle(.iconOnly).font(.title3).foregroundStyle(look.accent)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      if !folded {
        ForEach(folder.agents) { agent in
          Divider().overlay(look.line).padding(.leading, 38)
          AgentRow(model: model, agent: agent, open: { open(agent.key) })
        }
      }
    }
    .background(look.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private func toggle() {
    model.update { state in
      guard let p = state.projects.firstIndex(where: { $0.id == project.id }) else { return }
      if folder.other {
        state.projects[p].otherCollapsed = folder.folder.collapsed == true ? nil : true
      } else if let f = state.projects[p].folders.firstIndex(where: { $0.id == folder.folder.id }) {
        state.projects[p].folders[f].collapsed = folder.folder.collapsed == true ? nil : true
      }
    }
  }
}

struct AgentRow: View {
  let model: AppModel
  let agent: Agent
  let open: () -> Void
  @Environment(\.look) private var look
  @State private var failure: Notice?

  var body: some View {
    Button(action: open) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        StatusDot(status: agent.status).padding(.leading, 2)
        VStack(alignment: .leading, spacing: 3) {
          Text(model.name(of: agent)).font(.body).foregroundStyle(agent.alive ? look.text : look.dim).lineLimit(2).multilineTextAlignment(.leading)
          Text(line).font(.footnote).foregroundStyle(agent.status == "waiting" ? look.waiting : look.dim).lineLimit(2).multilineTextAlignment(.leading)
        }
        Spacer(minLength: 6)
        Text(ago(max(agent.attnTs, agent.activityTs))).font(.caption.monospacedDigit()).foregroundStyle(look.faint)
        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(look.faint)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("agent-\(agent.agentId)")
    .contextMenu { AgentActions(model: model, agent: agent, failure: $failure) }
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
  }

  private var line: String {
    if agent.status == "waiting" { return agent.needs ?? "waiting for you" }
    return agent.doing == agent.status ? statusWord(agent) : agent.doing
  }
}

/// Stop, remove, rename: what can be done to an agent from its row or its screen.
struct AgentActions: View {
  let model: AppModel
  let agent: Agent
  @Binding var failure: Notice?
  var gone: () -> Void = {}

  var body: some View {
    if agent.isBackground {
      if agent.alive {
        Button("Stop", systemImage: "stop.circle") { act { try await model.stop(agent) } }
      } else {
        Button("Remove from the list", systemImage: "eye.slash") {
          model.hide(agent.key)
          gone()
        }
      }
    } else {
      Button(agent.alive ? "Stop and remove" : "Remove", systemImage: "trash", role: .destructive) {
        act {
          try await model.stop(agent)
          gone()
        }
      }
    }
  }

  private func act(_ what: @escaping () async throws -> Void) {
    Task {
      do { try await what() } catch { failure = Notice(title: "That did not work", text: error.localizedDescription) }
    }
  }
}

/// A new agent in a folder: what it should do.
struct NewAgentSheet: View {
  let model: AppModel
  let place: StartIn
  let started: (String) -> Void
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var prompt = ""
  @State private var busy = false
  @State private var failure: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            TextField("What should it do?", text: $prompt, axis: .vertical).lineLimit(4...12).focused($focused).accessibilityIdentifier("new-agent-prompt")
          } footer: {
            Text("Starts `\(place.project.agentCommand)` in \(place.folder.path) on \(place.project.host). Leave it empty to start without a task.")
          }
          if let failure { Section { Text(failure).foregroundStyle(look.danger).textSelection(.enabled) } }
        }
        .listRowBackground(look.panel)
      }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .navigationTitle("New agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if busy { ProgressView() } else { Button("Start", action: start).accessibilityIdentifier("new-agent-start") }
        }
      }
      .onAppear { focused = true }
    }
    .presentationDetents([.medium, .large])
  }

  private func start() {
    busy = true
    failure = nil
    Task {
      do {
        let key = try await model.spawn(project: place.project, folder: place.folder, prompt: prompt)
        dismiss()
        started(key)
      } catch {
        failure = error.localizedDescription
      }
      busy = false
    }
  }
}
#endif
