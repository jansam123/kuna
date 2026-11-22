#if os(iOS)
import KunaCore
import SwiftUI

/// How the home screen lays the projects out. Three to compare (Settings ▸ Home screen); the
/// others go once one is chosen.
enum HomeLook: String, CaseIterable, Identifiable {
  case blocks, strip, tiles
  var id: String { rawValue }
  var name: String {
    switch self {
    case .blocks: "A · Blocks, as the Mac's sidebar"
    case .strip: "C · Icon strip, one project at a time"
    case .tiles: "D · Tiles, then the project"
    }
  }
}

/// What a tap in the projects does, handed down from the home screen.
struct ProjectActions {
  /// an agent's screen
  var open: (String) -> Void
  var edit: (Project) -> Void
  /// a new agent in the folder, or (true) a terminal
  var start: (Project, Folder, Bool) -> Void
  /// a project's own page (the tiles)
  var show: (Project) -> Void
  /// a folder's files, to look through
  var files: (Project, Folder) -> Void
}

/// A project's icon as on the Mac (ProjectIcon.tsx): one of its line drawings, a letter of your
/// own in the math font, or the name's initial. Takes the foreground colour.
struct ProjectIcon: View {
  let model: AppModel
  var icon: String?
  var name: String
  var size: CGFloat = 20

  var body: some View {
    if let shapes = model.icons[icon ?? ""] {
      Canvas { context, area in
        let k = area.width / 24
        for shape in shapes {
          var path = Path()
          for op in shape.ops {
            switch (Int(op[0]), op.count) {
            case (0, 3): path.move(to: CGPoint(x: op[1], y: op[2]))
            case (1, 3): path.addLine(to: CGPoint(x: op[1], y: op[2]))
            case (2, 7): path.addCurve(to: CGPoint(x: op[5], y: op[6]), control1: CGPoint(x: op[1], y: op[2]), control2: CGPoint(x: op[3], y: op[4]))
            default: path.closeSubpath()
            }
          }
          path = path.applying(CGAffineTransform(scaleX: k, y: k))
          if shape.fill == true { context.fill(path, with: .foreground) }
          if shape.stroke != false {
            context.stroke(path, with: .foreground, style: StrokeStyle(lineWidth: (shape.w ?? 1.8) * k, lineCap: .round, lineJoin: .round, dash: (shape.dash ?? []).map { $0 * k }))
          }
        }
      }
      .frame(width: size, height: size)
      .accessibilityHidden(true)
    } else if let icon, !icon.isEmpty {
      Text(icon).font(.system(size: size * 0.95, design: .serif)).italic().frame(width: size, height: size).accessibilityHidden(true)
    } else {
      Text(String(model.plain(name).first { $0.isLetter || $0.isNumber } ?? "·").uppercased())
        .font(.system(size: size * 0.8, weight: .bold)).frame(width: size, height: size).accessibilityHidden(true)
    }
  }
}

extension ProjectIcon {
  init(model: AppModel, project: Project, size: CGFloat = 20) {
    self.init(model: model, icon: project.icon, name: project.name, size: size)
  }
}

/// A project's agents in numbers, as its row on the Mac counts them: waiting, working, failed.
struct Rollup: View {
  let agents: [Agent]
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 8) {
      count("waiting", look.waiting, "waiting for you")
      count("working", look.working, "working")
      count("failed", look.danger, "failed")
    }
  }

  @ViewBuilder
  private func count(_ status: String, _ color: Color, _ words: String) -> some View {
    let n = agents.filter { $0.status == status }.count
    if n > 0 {
      HStack(spacing: 3) {
        Circle().fill(color).frame(width: 6, height: 6)
        Text("\(n)").font(.caption.monospacedDigit())
      }
      .foregroundStyle(color)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(n) \(words)")
    }
  }
}

/// How many of the project's agents run, in a pill of its colour.
struct RunningCount: View {
  let tree: ProjectTree
  @Environment(\.look) private var look

  var body: some View {
    let n = tree.agents.filter { $0.status != "exited" && $0.status != "failed" }.count
    if n > 0 {
      Text("\(n)").font(.caption.monospacedDigit()).foregroundStyle(look.text).padding(.horizontal, 6).frame(minWidth: 20, minHeight: 18)
        .background(Color(hex: tree.project.color).opacity(0.3), in: Capsule())
        .accessibilityLabel("\(n) running")
    }
  }
}

/// The host a project is on; with a dot and a word while it is not simply connected.
struct HostBadge: View {
  let model: AppModel
  let project: Project
  @Environment(\.look) private var look

  var body: some View {
    let phase = model.links[project.host]?.phase
    HStack(spacing: 4) {
      if phase != .ready {
        StatusDot(status: { if case .failed = phase { "failed" } else { "starting" } }(), size: 6)
      }
      Text(project.host).font(.caption.monospaced()).foregroundStyle(look.dim.mix(with: Color(hex: project.color), by: 0.35)).lineLimit(1)
    }
  }
}

extension Color {
  /// the project colour's tint of a surface, as the Mac's `color-mix(var(--proj) n%, var(--panel))`
  func tint(_ project: Color, _ amount: Double) -> Color { mix(with: project, by: amount) }
}

/// The header of a project's block: icon, name, host, its agents in numbers. A tap rolls it in or out.
struct ProjectHeader: View {
  let model: AppModel
  let tree: ProjectTree
  let actions: ProjectActions
  @Environment(\.look) private var look

  var body: some View {
    let project = tree.project
    let color = Color(hex: project.color)
    let folded = project.collapsed == true
    HStack(spacing: 10) {
      Button {
        model.update { state in
          if let i = state.projects.firstIndex(where: { $0.id == project.id }) { state.projects[i].collapsed = folded ? nil : true }
        }
      } label: {
        HStack(spacing: 10) {
          ProjectIcon(model: model, project: project, size: 22).foregroundStyle(color)
          Text(model.plain(project.name)).font(.headline).foregroundStyle(look.text).lineLimit(1)
          HostBadge(model: model, project: project).layoutPriority(-1)
          Spacer(minLength: 4)
          Rollup(agents: tree.agents)
          RunningCount(tree: tree)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("project-\(project.id)")
      Button("Edit \(model.plain(project.name))", systemImage: "ellipsis", action: { actions.edit(project) }).labelStyle(.iconOnly).foregroundStyle(look.dim).frame(width: 30, height: 30)
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(look.faint).rotationEffect(.degrees(folded ? 0 : 90))
    }
  }
}

/// A project's folders and their agents. `flat`: rows of the project's block; otherwise a card for each folder.
struct ProjectFolders: View {
  let model: AppModel
  let tree: ProjectTree
  let actions: ProjectActions
  var flat = false
  @Environment(\.look) private var look

  var body: some View {
    if tree.folders.isEmpty {
      Button("Add a folder to start agents in", systemImage: "plus") { actions.edit(tree.project) }.font(.subheadline).padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    ForEach(tree.folders) { folder in
      FolderRows(model: model, project: tree.project, folder: folder, actions: actions, flat: flat)
      if flat, folder.id != tree.folders.last?.id { Divider().overlay(look.line.opacity(0.6)) }
    }
  }
}

private struct FolderRows: View {
  let model: AppModel
  let project: Project
  let folder: FolderTree
  let actions: ProjectActions
  let flat: Bool
  @Environment(\.look) private var look

  var body: some View {
    let folded = folder.folder.collapsed == true
    let name = model.plain(folder.folder.name)
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Button(action: toggle) {
          HStack(spacing: 8) {
            Image(systemName: folder.other ? "tray" : "folder.fill").font(.footnote).foregroundStyle(Color(hex: folder.folder.color))
            Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(look.text).lineLimit(1)
            if folded, !folder.agents.isEmpty { Text("\(folder.agents.count)").font(.caption.monospacedDigit()).foregroundStyle(look.dim) }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !folder.other {
          Button("Files of \(name)", systemImage: "doc.text.magnifyingglass") { actions.files(project, folder.folder) }
            .labelStyle(.iconOnly).font(.body).foregroundStyle(look.dim).buttonStyle(.plain).padding(.trailing, 4)
          Menu("New in \(name)", systemImage: "plus.circle.fill") {
            Button("New agent", systemImage: "sparkles") { actions.start(project, folder.folder, false) }
            Button("New terminal", systemImage: "apple.terminal") { actions.start(project, folder.folder, true) }
          }
          .labelStyle(.iconOnly).font(.title3).foregroundStyle(flat ? look.dim : look.accent)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      if !folded {
        ForEach(folder.agents) { agent in
          Divider().overlay(look.line.opacity(flat ? 0.5 : 1)).padding(.leading, 60)
          // under its folder's name, as the Mac's sidebar sets agents in
          AgentRow(model: model, agent: agent, open: { actions.open(agent.key) }).padding(.leading, 22)
        }
      }
    }
    .background(flat ? Color.clear : look.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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

// MARK: - A: blocks, as the Mac's sidebar

/// Each project one block in its colour, with room around it and round corners: a spine at the
/// left through its header and rows, the header fading to the right, the rows on a faint tint.
struct BlocksHome: View {
  let model: AppModel
  let actions: ProjectActions
  @Environment(\.look) private var look

  var body: some View {
    LazyVStack(spacing: 14) {
      ForEach(model.tree) { tree in
        let color = Color(hex: tree.project.color)
        VStack(spacing: 0) {
          ProjectHeader(model: model, tree: tree, actions: actions).padding(.leading, 14).padding(.trailing, 12).frame(height: 50)
            .background(LinearGradient(colors: [look.panel.tint(color, 0.24), look.panel.tint(color, 0.06)], startPoint: .leading, endPoint: .trailing))
            .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 3) }
          if tree.project.collapsed != true {
            VStack(spacing: 0) { ProjectFolders(model: model, tree: tree, actions: actions, flat: true) }
              .overlay(alignment: .leading) { Rectangle().fill(look.panel.tint(color, 0.45)).frame(width: 3) }
          }
        }
        .background(look.panel.tint(color, 0.05))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      }
    }
    .padding(.horizontal, 14)
  }
}

// MARK: - C: the Mac's project strip, across the top

/// The projects' icons in a row, a number on those with agents waiting; a tap shows that project alone.
struct ProjectStrip: View {
  let model: AppModel
  @Binding var selected: String
  @Environment(\.look) private var look

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 12) {
        ForEach(model.tree) { tree in
          let color = Color(hex: tree.project.color)
          let on = tree.id == selected
          let waiting = tree.agents.filter { $0.status == "waiting" }.count
          Button { selected = tree.id } label: {
            ProjectIcon(model: model, project: tree.project, size: 24).foregroundStyle(on ? look.ground : color).frame(width: 46, height: 46)
              .background(on ? color : color.opacity(0.16), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
              .overlay(alignment: .topTrailing) {
                if waiting > 0 {
                  Text("\(waiting)").font(.system(size: 11, weight: .bold).monospacedDigit()).foregroundStyle(.black).frame(minWidth: 18, minHeight: 18)
                    .background(look.waiting, in: Capsule()).overlay { Capsule().strokeBorder(look.ground, lineWidth: 2) }.offset(x: 6, y: -6)
                }
              }
          }
          .buttonStyle(.plain)
          .accessibilityLabel(model.plain(tree.project.name))
          .accessibilityIdentifier("strip-\(tree.id)")
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
    }
    .background(look.ground)
    .overlay(alignment: .bottom) { Divider().overlay(look.line) }
  }
}

/// One project as a page: its name and numbers, then a card for each folder.
struct ProjectPage: View {
  let model: AppModel
  let tree: ProjectTree
  let actions: ProjectActions
  /// the name as a heading (the strip); a pushed page has it in its bar
  var heading = true
  @Environment(\.look) private var look

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        if heading { Text(model.plain(tree.project.name)).font(.title2.weight(.bold)).foregroundStyle(look.text).lineLimit(2) }
        HostBadge(model: model, project: tree.project)
        Spacer(minLength: 4)
        Rollup(agents: tree.agents)
        RunningCount(tree: tree)
        if heading {
          Button("Edit \(model.plain(tree.project.name))", systemImage: "ellipsis") { actions.edit(tree.project) }.labelStyle(.iconOnly).foregroundStyle(look.dim).frame(width: 30, height: 30)
        }
      }
      .padding(.horizontal, 6)
      ProjectFolders(model: model, tree: tree, actions: actions)
    }
    .padding(.horizontal, 16)
  }
}

// MARK: - D: tiles

/// The projects as tiles, two across; a tap opens the project's page.
struct TilesHome: View {
  let model: AppModel
  let actions: ProjectActions
  @Environment(\.look) private var look

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
      ForEach(model.tree) { tree in
        let color = Color(hex: tree.project.color)
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        Button { actions.show(tree.project) } label: {
          VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
              ProjectIcon(model: model, project: tree.project, size: 30).foregroundStyle(color)
              Spacer()
              RunningCount(tree: tree)
            }
            Spacer(minLength: 6)
            Text(model.plain(tree.project.name)).font(.headline).foregroundStyle(look.text).lineLimit(2).multilineTextAlignment(.leading)
            HostBadge(model: model, project: tree.project)
            HStack {
              Rollup(agents: tree.agents)
              if !tree.agents.contains(where: { ["waiting", "working", "failed"].contains($0.status) }) {
                Text(tree.agents.isEmpty ? "no agents" : "all quiet").font(.caption).foregroundStyle(look.faint)
              }
            }
            .frame(height: 16)
          }
          .padding(14)
          .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
          .background(LinearGradient(colors: [look.panel.tint(color, 0.26), look.panel.tint(color, 0.05)], startPoint: .topLeading, endPoint: .bottomTrailing), in: shape)
          .overlay { shape.strokeBorder(color.opacity(0.22)) }
          .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("project-\(tree.id)")
        .contextMenu { Button("Edit", systemImage: "pencil") { actions.edit(tree.project) } }
      }
    }
    .padding(.horizontal, 16)
  }
}
#endif
