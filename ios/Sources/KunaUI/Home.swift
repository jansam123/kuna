#if os(iOS)
import KunaCore
import SwiftUI

/// What the app opens with: the projects, their folders and their agents, as the Mac's sidebar.
struct HomeView: View {
  let model: AppModel
  @Binding var path: [Route]
  @Binding var notice: Notice?
  @Binding var importing: Bool
  /// to the hosts, in Settings
  let hosts: () -> Void
  @Environment(\.look) private var look
  @AppStorage("homeLook") private var homeLook = HomeLook.blocks.rawValue
  @AppStorage("stripProject") private var stripProject = ""
  @State private var sheets = ProjectSheets.State()

  var body: some View {
    let style = HomeLook(rawValue: homeLook) ?? .blocks
    let actions = $sheets.actions(model: model, path: $path, notice: $notice)
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 18) {
        if !troubled.isEmpty || model.state.projects.isEmpty {
          VStack(spacing: 18) {
            ForEach(troubled) { link in HostBanner(model: model, link: link, edit: hosts) }
            if model.state.projects.isEmpty { Welcome(importing: $importing, new: { sheets.editing = ProjectDraft(model: model) }) }
          }
          .padding(.horizontal, 16)
        }
        switch style {
        case .blocks: BlocksHome(model: model, actions: actions)
        case .tiles: TilesHome(model: model, actions: actions)
        case .strip:
          if let tree = model.tree.first(where: { $0.id == stripProject }) ?? model.tree.first { ProjectPage(model: model, tree: tree, actions: actions) }
        }
      }
      .padding(.vertical, 8)
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      if style == .strip, model.tree.count > 1 {
        ProjectStrip(model: model, selected: Binding(get: { model.tree.contains { $0.id == stripProject } ? stripProject : model.tree.first?.id ?? "" }, set: { stripProject = $0 }))
      }
    }
    .background(look.ground)
    .refreshable {
      for link in model.links.values where !link.ready { model.reconnect(link.alias) }
      try? await Task.sleep(for: .milliseconds(600))
    }
    .navigationTitle("Kuna")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu("Add", systemImage: "plus") {
          Button("New project", systemImage: "folder.badge.plus") { sheets.editing = ProjectDraft(model: model) }
          Button("Import from the Mac", systemImage: "square.and.arrow.down") { importing = true }
        }
      }
    }
    .modifier(ProjectSheets(model: model, state: $sheets, path: $path))
  }

  /// hosts that are not simply connected: said at the top, with what to do
  private var troubled: [HostLink] {
    model.links.values.filter { $0.phase != .ready }.sorted { $0.alias < $1.alias }
  }
}

/// One project's page, opened from its tile.
struct ProjectScreen: View {
  let model: AppModel
  let id: String
  @Binding var path: [Route]
  @Binding var notice: Notice?
  @Environment(\.look) private var look
  @State private var sheets = ProjectSheets.State()

  var body: some View {
    let actions = $sheets.actions(model: model, path: $path, notice: $notice)
    ScrollView {
      if let tree = model.tree.first(where: { $0.id == id }) {
        ProjectPage(model: model, tree: tree, actions: actions, heading: false).padding(.vertical, 8)
      } else {
        ContentUnavailableView("This project is gone", systemImage: "folder")
      }
    }
    .background(look.ground)
    .navigationTitle(model.tree.first { $0.id == id }.map { model.plain($0.project.name) } ?? "")
    .toolbar {
      if let tree = model.tree.first(where: { $0.id == id }) {
        ToolbarItem(placement: .primaryAction) { Button("Edit", systemImage: "ellipsis") { actions.edit(tree.project) } }
      }
    }
    .modifier(ProjectSheets(model: model, state: $sheets, path: $path))
  }
}

/// The sheets a screen with projects on it needs: a project's form, a new agent's task.
struct ProjectSheets: ViewModifier {
  struct State {
    var editing: ProjectDraft?
    var starting: StartIn?
  }

  let model: AppModel
  @Binding var state: State
  @Binding var path: [Route]
  @Environment(\.look) private var look

  func body(content: Content) -> some View {
    content
      .sheet(item: $state.editing) { draft in ProjectForm(model: model, draft: draft).environment(\.look, look) }
      .sheet(item: $state.starting) { place in
        NewAgentSheet(model: model, place: place) { key in path.append(.agent(key)) }.environment(\.look, look)
      }
  }
}

extension Binding where Value == ProjectSheets.State {
  /// What taps in the projects do on this screen.
  @MainActor
  func actions(model: AppModel, path: Binding<[Route]>, notice: Binding<Notice?>) -> ProjectActions {
    ProjectActions(
      open: { path.wrappedValue.append(.agent($0)) },
      edit: { wrappedValue.editing = ProjectDraft(model: model, project: $0) },
      start: { project, folder, shell in
        guard shell else { return wrappedValue.starting = StartIn(project: project, folder: folder) }
        Task { await startTerminal(model, project, folder, nil, path, notice) }
      },
      show: { path.wrappedValue.append(.project($0.id)) },
      files: { project, folder in path.wrappedValue.append(.files(project.host, folder.path)) })
  }
}

/// A terminal (your shell) in a folder of a project, or where an agent works; opens it.
@MainActor
func startTerminal(_ model: AppModel, _ project: Project, _ folder: Folder, _ cwd: String?, _ path: Binding<[Route]>, _ notice: Binding<Notice?>) async {
  do {
    path.wrappedValue.append(.agent(try await model.spawn(project: project, folder: folder, prompt: "", shell: true, cwd: cwd)))
  } catch {
    notice.wrappedValue = Notice(title: "The terminal did not start", text: error.localizedDescription)
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
      .keyboardButton()
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
