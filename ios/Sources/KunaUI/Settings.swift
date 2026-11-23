#if os(iOS)
import KunaCore
import SwiftUI

struct SettingsView: View {
  let model: AppModel
  @Binding var importing: Bool
  @Environment(\.look) private var look
  @AppStorage("lock") private var lock = true
  @AppStorage("homeLook") private var homeLook = HomeLook.blocks.rawValue
  @AppStorage("termFont") private var termFont = 11.0
  @AppStorage("opensTerminal") private var opensTerminal = true
  @AppStorage("haptics") private var haptics = true
  @AppStorage(Haptic.Moment.opened.rawValue) private var hapticOpen = Haptic.Moment.opened.usual.rawValue
  @AppStorage(Haptic.Moment.sent.rawValue) private var hapticSend = Haptic.Moment.sent.usual.rawValue
  @State private var host: HostDraft?

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            ForEach(model.state.hosts) { h in
              Button { host = HostDraft(model: model, host: h) } label: {
                HStack(spacing: 10) {
                  StatusDot(status: status(h.alias))
                  VStack(alignment: .leading, spacing: 2) {
                    Text(h.alias).foregroundStyle(look.text)
                    Text("\(h.user)@\(h.hostName)" + (h.jump.map { " through \($0)" } ?? "")).font(.footnote).foregroundStyle(look.dim).lineLimit(1)
                  }
                  Spacer(minLength: 0)
                  Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(look.faint)
                }
              }
            }
            Button("Add a host", systemImage: "plus") { host = HostDraft(model: model) }
          } header: {
            Text("Hosts")
          } footer: {
            Text("A host is signed in to when a project is on it, or when another host is reached through it.")
          }

          Section {
            if model.publicKey.isEmpty {
              Text("This phone could not make a key.").foregroundStyle(look.dim)
            } else {
              // not for whoever looks over a shoulder: its kind and its first letters, the rest by copying
              HStack {
                Text(masked).font(.caption.monospaced()).foregroundStyle(look.dim).lineLimit(1).accessibilityIdentifier("public-key")
                Spacer(minLength: 4)
                CopyButton(text: model.publicKey, label: "Copy the key").accessibilityIdentifier("copy-key")
              }
              ShareLink("Send it to your Mac", item: model.publicKey)
            }
          } header: {
            Text("This phone's key")
          } footer: {
            Text("Add this line to ~/.ssh/authorized_keys on each host, and on the hosts they are reached through. The key never leaves this phone. Hosts that take a password need no key.")
          }

          Section {
            Button("Import from the Mac", systemImage: "square.and.arrow.down") { importing = true }
          } footer: {
            Text(imported)
          }

          Section {
            Picker("Projects", selection: $homeLook) {
              ForEach(HomeLook.allCases) { Text($0.name).tag($0.rawValue) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
          } header: {
            Text("Home screen")
          } footer: {
            Text("Three ways to lay the projects out, to compare. The others go once you have chosen.")
          }

          Section {
            Picker("An agent opens in", selection: $opensTerminal) {
              Text("Terminal").tag(true)
              Text("Conversation").tag(false)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("opens-terminal")
          } header: {
            Text("An agent opens in")
          } footer: {
            Text("What an agent's screen shows first; the button at its top swaps to the other.")
          }

          Section {
            Toggle("Haptics", isOn: $haptics)
            if haptics {
              Picker("An agent opens", selection: $hapticOpen) { ForEach(Haptic.allCases) { Text($0.name).tag($0.rawValue) } }
              Picker("A message is sent", selection: $hapticSend) { ForEach(Haptic.allCases) { Text($0.name).tag($0.rawValue) } }
              // the palette: each one to feel before it is chosen above
              LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
                ForEach(Haptic.allCases.filter { $0 != .none }) { haptic in
                  Button(haptic.name) { haptic.play() }.font(.footnote.weight(.medium)).frame(maxWidth: .infinity, minHeight: 36)
                    .background(look.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous)).foregroundStyle(look.text)
                    .buttonStyle(.plain).accessibilityIdentifier("haptic-\(haptic.rawValue)")
                }
              }
              .padding(.vertical, 4)
            }
          } header: {
            Text("Haptics")
          } footer: {
            Text("A tap of the phone when an agent's screen has connected, and when a message is sent. Tap one to feel it.")
          }

          Section("Colours") {
            ForEach(model.themes) { theme in
              Button {
                model.update {
                  $0.theme = theme.id
                  $0.themeChosen = true
                }
              } label: {
                HStack(spacing: 12) {
                  HStack(spacing: 0) {
                    Color(hex: theme.ground)
                    Color(hex: theme.raised)
                    Color(hex: theme.accent)
                  }
                  .frame(width: 44, height: 26).clipShape(RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(look.line))
                  VStack(alignment: .leading, spacing: 2) {
                    Text(theme.name).foregroundStyle(look.text)
                    Text(theme.blurb).font(.caption).foregroundStyle(look.dim).lineLimit(2)
                  }
                  Spacer(minLength: 0)
                  if theme.id == model.theme.id { Image(systemName: "checkmark").foregroundStyle(look.accent) }
                }
              }
            }
          }

          Section {
            if !model.state.hidden.isEmpty {
            Button("Show the \(model.state.hidden.count) session\(model.state.hidden.count == 1 ? "" : "s") taken off the list again") { model.update { $0.hidden = [:] } }
          }
          Toggle("Ask for Face ID when Kuna opens", isOn: $lock)
            Stepper("Terminal text: \(Int(termFont)) pt", value: $termFont, in: 8...18)
          } footer: {
            Text("Saved passwords are in this iPhone's keychain and are not in backups to other devices.")
          }
        }
        .listRowBackground(look.panel)
      }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: hapticOpen) { (Haptic(rawValue: hapticOpen) ?? .none).play() }
      .onChange(of: hapticSend) { (Haptic(rawValue: hapticSend) ?? .none).play() }
      .sheet(item: $host) { draft in HostForm(model: model, draft: draft).environment(\.look, look) }
    }
  }

  /// the key's kind and the first letters of the key itself
  private var masked: String {
    let parts = model.publicKey.split(separator: " ")
    return "\(parts.first ?? "") \(parts.dropFirst().first?.prefix(8) ?? "")" + String(repeating: "•", count: 14)
  }

  private func status(_ alias: String) -> String {
    switch model.links[alias]?.phase {
    case .ready: "idle"
    case .failed: "failed"
    case .connecting, .installing: "starting"
    default: "exited"
    }
  }

  private var imported: String {
    guard let at = model.state.importedAt, at > 0 else { return "On the Mac: Kuna ▸ Export for iPhone…, then send the file here. Projects made on this phone stay." }
    return "Last import: an export made \(Date(timeIntervalSince1970: at).formatted(date: .abbreviated, time: .shortened)). Importing again updates what came from the Mac; projects made on this phone stay."
  }
}

/// A host being added or changed.
@MainActor @Observable
final class HostDraft: Identifiable {
  let id = UUID()
  let original: Host?
  var host: Host
  var password: String
  var port: String

  init(model: AppModel, host: Host? = nil) {
    original = host
    self.host = host ?? Host()
    password = host.map { model.password($0) } ?? ""
    port = String(host?.port ?? 22)
  }
}

struct HostForm: View {
  let model: AppModel
  @Bindable var draft: HostDraft
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var problem: String?
  @State private var deleting = false

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            TextField("Name, e.g. cluster1", text: $draft.host.alias).plain().disabled(draft.original != nil)
            TextField("Address (HostName)", text: $draft.host.hostName).plain().keyboardType(.URL)
            TextField("User", text: $draft.host.user).plain()
            TextField("Port", text: $draft.port).keyboardType(.numberPad)
          } header: {
            Text("Host")
          } footer: {
            Text(draft.original == nil ? "The name is what the Mac calls the host in ~/.ssh/config: agents and projects are filed under it." : "The name cannot change: agents and projects are filed under it.")
          }
          Section {
            Picker("Reached through", selection: Binding(get: { draft.host.jump ?? "" }, set: { draft.host.jump = $0.isEmpty ? nil : $0 })) {
              Text("Directly").tag("")
              ForEach(model.state.hosts.filter { $0.alias != draft.host.alias }) { Text($0.alias).tag($0.alias) }
            }
          } footer: {
            Text("ProxyJump: the host that is signed in to first. Add that one as a host of its own.")
          }
          Section {
            SecureField("Password", text: $draft.password)
          } footer: {
            Text("Only for a host that takes a password. This phone's key is always offered first. A host that asks for a one-time code cannot be signed in to.")
          }
          if let original = draft.original {
            Section {
              let known = model.state.hostKeys[original.target.knownHostsName] ?? []
              ForEach(known, id: \.self) { key in
                Text(fingerprint(openSSHKey: key)).font(.caption.monospaced()).foregroundStyle(look.dim).textSelection(.enabled)
              }
              if known.isEmpty { Text("None yet: the first connection asks.").foregroundStyle(look.dim) } else {
                Button("Forget its key", role: .destructive) { model.forgetKeys(of: original) }
              }
            } header: {
              Text("Host key this phone trusts")
            }
            Section {
              Button("Save and connect again") { if save() { dismiss() } }
              Button("Remove this host", role: .destructive) { deleting = true }
            }
          }
          if let problem { Section { Text(problem).foregroundStyle(look.danger) } }
        }
        .listRowBackground(look.panel)
      }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .navigationTitle(draft.original?.alias ?? "New host")
      .keyboardButton()
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) { Button("Save") { if save() { dismiss() } } }
      }
      .confirmationDialog("Remove \(draft.host.alias)?", isPresented: $deleting, titleVisibility: .visible) {
        Button("Remove the host", role: .destructive) {
          let alias = draft.host.alias
          model.setPassword(draft.host, "")
          model.update { state in
            state.hosts.removeAll { $0.alias == alias }
            for i in state.hosts.indices where state.hosts[i].jump == alias { state.hosts[i].jump = nil }
          }
          dismiss()
        }
      } message: {
        Text(model.state.projects.contains { $0.host == draft.host.alias } ? "Projects on it stay, and say that the host is missing until it is added again." : "Its saved password is removed too.")
      }
    }
    .preferredColorScheme(.dark)
  }

  @discardableResult
  private func save() -> Bool {
    var host = draft.host
    host.alias = host.alias.trimmingCharacters(in: .whitespaces)
    host.hostName = host.hostName.trimmingCharacters(in: .whitespaces)
    host.user = host.user.trimmingCharacters(in: .whitespaces)
    host.port = Int(draft.port) ?? 22
    guard model.validAlias(host.alias) else { return fail("Give the host a name without spaces.") }
    guard model.validAlias(host.hostName) else { return fail("Fill in the host's address, e.g. login.example.org.") }
    guard !host.user.isEmpty, !host.user.contains(" ") else { return fail("Fill in the user to sign in as.") }
    guard (1...65535).contains(host.port) else { return fail("The port is a number, 22 unless the host says otherwise.") }
    if draft.original == nil, model.host(host.alias) != nil { return fail("There is already a host called \(host.alias).") }
    if let old = draft.original, old.passwordAccount != host.passwordAccount { model.setPassword(old, "") }
    model.setPassword(host, draft.password)
    model.update { state in
      if let i = state.hosts.firstIndex(where: { $0.alias == host.alias }) { state.hosts[i] = host } else { state.hosts.append(host) }
    }
    if draft.original != nil { model.reconnect(host.alias) }
    return true
  }

  private func fail(_ why: String) -> Bool {
    problem = why
    return false
  }
}

/// A project being made or changed: its name, host, command and folders.
@MainActor @Observable
final class ProjectDraft: Identifiable {
  let id = UUID()
  let isNew: Bool
  var project: Project

  init(model: AppModel, project: Project? = nil) {
    isNew = project == nil
    self.project = project ?? Project(name: "", host: model.state.hosts.first?.alias ?? "", color: model.repoColors[model.state.projects.count % max(1, model.repoColors.count)])
  }
}

struct ProjectForm: View {
  let model: AppModel
  @Bindable var draft: ProjectDraft
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var newFolder = ""
  @State private var problem: String?
  @State private var deleting = false
  @State private var addingHost: HostDraft?

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section("Project") {
            TextField("Name", text: $draft.project.name)
            Picker("Host", selection: $draft.project.host) {
              if model.host(draft.project.host) == nil { Text(draft.project.host.isEmpty ? "Choose…" : "\(draft.project.host) (missing)").tag(draft.project.host) }
              ForEach(model.state.hosts) { Text($0.alias).tag($0.alias) }
            }
            Button("Add a host", systemImage: "plus") { addingHost = HostDraft(model: model) }
          }
          Section {
            TextField("claude", text: $draft.project.agentCommand).plain().font(.body.monospaced())
            if draft.project.startsClaude {
              Picker("New agents run", selection: Binding(get: { draft.project.launch ?? "background" }, set: { draft.project.launch = $0 == "background" ? nil : $0 })) {
                Text("As Claude Code background sessions").tag("background")
                Text("In Kuna's tmux").tag("tmux")
              }
            }
          } header: {
            Text("Command that starts an agent")
          } footer: {
            Text("For example `claude --model opus`. Any other agent command runs in Kuna's tmux and opens in the terminal.")
          }
          Section {
            ForEach($draft.project.folders) { $folder in
              VStack(alignment: .leading, spacing: 4) {
                TextField("Name", text: $folder.name)
                TextField("Path on the host", text: $folder.path).plain().font(.footnote.monospaced()).foregroundStyle(look.dim)
              }
            }
            .onDelete { draft.project.folders.remove(atOffsets: $0) }
            .onMove { draft.project.folders.move(fromOffsets: $0, toOffset: $1) }
            HStack {
              TextField("~/path/on/the/host", text: $newFolder).plain().font(.body.monospaced()).onSubmit(addFolder).accessibilityIdentifier("new-folder-path")
              Button("Add", action: addFolder).disabled(newFolder.trimmingCharacters(in: .whitespaces).isEmpty)
            }
          } header: {
            Text("Folders")
          } footer: {
            Text("Agents start in a folder, and an agent running in or below it is listed under it.")
          }
          ColorSection(colors: model.repoColors, color: $draft.project.color)
          IconSection(model: model, project: $draft.project)
          if !draft.isNew {
            Section { Button("Remove this project", role: .destructive) { deleting = true } } footer: { Text("Its agents keep running on the host; they are no longer listed here unless another project is on that host.") }
          }
          if let problem { Section { Text(problem).foregroundStyle(look.danger) } }
        }
        .listRowBackground(look.panel)
      }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .navigationTitle(draft.isNew ? "New project" : draft.project.name)
      .keyboardButton()
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).accessibilityIdentifier("project-save") }
      }
      .confirmationDialog("Remove \(draft.project.name)?", isPresented: $deleting, titleVisibility: .visible) {
        Button("Remove the project", role: .destructive) {
          model.update { $0.projects.removeAll { $0.id == draft.project.id } }
          dismiss()
        }
      }
      .sheet(item: $addingHost, onDismiss: { if draft.project.host.isEmpty, let last = model.state.hosts.last { draft.project.host = last.alias } }) { host in
        HostForm(model: model, draft: host).environment(\.look, look)
      }
    }
    .preferredColorScheme(.dark)
  }

  private func addFolder() {
    var path = newFolder.trimmingCharacters(in: .whitespaces)
    guard !path.isEmpty else { return }
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    guard path.hasPrefix("/") || path == "~" || path.hasPrefix("~/") else {
      problem = "A folder's path starts with / or ~/."
      return
    }
    problem = nil
    let name = path.split(separator: "/").last.map(String.init) ?? path
    draft.project.folders.append(Folder(path: path, name: name == "~" ? "home" : name, color: model.repoColors[(draft.project.folders.count + 3) % max(1, model.repoColors.count)]))
    newFolder = ""
  }

  private func save() {
    addFolder()
    var project = draft.project
    project.name = project.name.trimmingCharacters(in: .whitespaces)
    project.agentCommand = project.agentCommand.trimmingCharacters(in: .whitespaces)
    if project.agentCommand.isEmpty { project.agentCommand = "claude" }
    guard !project.host.isEmpty else {
      problem = "Choose the host the project is on, or add one."
      return
    }
    if project.name.isEmpty { project.name = project.host }
    if problem != nil { return }
    model.update { state in
      if let i = state.projects.firstIndex(where: { $0.id == project.id }) { state.projects[i] = project } else { state.projects.append(project) }
    }
    dismiss()
  }
}

/// The Mac's project icons to pick from, or a letter of your own; none shows the name's initial.
private struct IconSection: View {
  let model: AppModel
  @Binding var project: Project
  @Environment(\.look) private var look

  var body: some View {
    let color = Color(hex: project.color)
    Section {
      TextField("A letter instead: μ, H, τ", text: Binding(get: { model.icons[project.icon ?? ""] == nil ? project.icon ?? "" : "" }, set: { project.icon = $0.isEmpty ? nil : String($0.prefix(2)) })).plain()
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 38), spacing: 6)], spacing: 6) {
        ForEach(model.iconNames, id: \.self) { name in
          let on = project.icon == name
          Button { project.icon = on ? nil : name } label: {
            ProjectIcon(model: model, icon: name, name: "", size: 22).foregroundStyle(on ? look.ground : color).frame(width: 38, height: 38)
              .background(on ? color : color.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(name)
        }
      }
      .padding(.vertical, 4)
    } header: {
      Text("Icon")
    } footer: {
      Text("As on the Mac. With none, the project shows the first letter of its name.")
    }
  }
}

private struct ColorSection: View {
  let colors: [String]
  @Binding var color: String

  var body: some View {
    Section("Colour") {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 10) {
          ForEach(colors, id: \.self) { c in
            Button { color = c } label: {
              Circle().fill(Color(hex: c)).frame(width: 28, height: 28)
                .overlay(Circle().strokeBorder(.white, lineWidth: c.lowercased() == color.lowercased() ? 2.5 : 0))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Colour \(c)")
          }
        }
        .padding(.vertical, 4)
      }
    }
  }
}
#endif
