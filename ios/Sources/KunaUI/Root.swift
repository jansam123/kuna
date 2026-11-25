#if os(iOS)
import KunaCore
import LocalAuthentication
import SwiftUI

enum Route: Hashable {
  case agent(String)
  /// an agent's plots and files; with a path (as a reply names it), that file in the viewer
  case plots(String, String? = nil)
  case review(String)
  /// a project's page, by its id
  case project(String)
  /// a folder on a host, to look through: the host, the folder
  case files(String, String)
}

struct Notice: Identifiable {
  let id = UUID()
  var title: String
  var text: String
}

/// The app's one model, made once: SwiftUI builds the root view more than once.
@MainActor
private enum Boot {
  static let model: AppModel = {
    #if targetEnvironment(simulator)
    // scripts/ios-sim.sh starts from nothing: `-kunaReset YES`
    if UserDefaults.standard.bool(forKey: "kunaReset") {
      try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: "Kuna/state.json"))
    }
    #endif
    return AppModel()
  }()
}

public struct RootView: View {
  private let model = Boot.model
  /// the tab in front, and where each of the first two is: both stay as they were left
  @State private var tab = "agents"
  @State private var path: [Route] = []
  @State private var places: [Route] = []
  @State private var locked = UserDefaults.standard.object(forKey: "lock") as? Bool ?? true
  @State private var left: Date?
  @State private var notice: Notice?
  @State private var open = OpenAgents()
  @State private var importing = false
  @Environment(\.scenePhase) private var scene
  @AppStorage("lock") private var lock = true

  public init() {}

  public var body: some View {
    let look = Look(model.theme)
    tabs
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .data, .item]) { result in
        if case .success(let url) = result { take(url, home: false) }
      }
    .environment(\.look, look)
    .tint(look.accent)
    .preferredColorScheme(.dark)
    .overlay { if locked { LockScreen(unlock: unlock) } }
    .alert("Trust this host?", isPresented: .constant(model.question != nil && !locked), presenting: model.question) { question in
      Button("Trust") { model.answer(question, true) }
      Button("Don't connect", role: .cancel) { model.answer(question, false) }
    } message: { question in
      Text("This phone has not connected to \(question.host) before, and your Mac's export had no key for it. Its key is\n\(question.fingerprint)\n\nOn your Mac, `ssh-keygen -lF \(question.host)` shows the key your Mac trusts.")
    }
    .alert(item: $notice) { notice in Alert(title: Text(notice.title), message: Text(notice.text)) }
    .onOpenURL { take($0, home: true) }
    .onChange(of: path + places) { _, now in
      open.keep(only: Set(now.compactMap { route in
        switch route {
        case .agent(let key), .plots(let key, _), .review(let key): key
        case .project, .files: nil
        }
      }))
    }
    .onChange(of: scene, initial: true) { _, now in
      switch now {
      case .active:
        // back after more than a minute away: ask again
        if lock, let left, Date().timeIntervalSince(left) > 60 { locked = true }
        left = nil
        if locked { unlock() } else { model.becomeActive() }
      case .background:
        left = left ?? Date()
        model.enterBackground()
      default: break
      }
    }
    .task {
      #if targetEnvironment(simulator)
      // scripts/ios-sim.sh hands the app its projects: `-kunaImport <file on the Mac>`
      if let file = UserDefaults.standard.string(forKey: "kunaImport"), let text = try? String(contentsOfFile: file, encoding: .utf8) {
        _ = try? model.importFile(text)
      }
      #endif
    }
  }

  /// Face ID (or the passcode) before anything is shown or any host is signed in to. A phone
  /// with neither has nothing to ask with, and opens.
  private func unlock() {
    let context = LAContext()
    guard lock, context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
      locked = false
      model.becomeActive()
      return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open Kuna and sign in to your hosts") { ok, _ in
      Task { @MainActor in
        guard ok else { return }
        locked = false
        model.becomeActive()
      }
    }
  }

  /// As a terminal app's tabs: what is open in one stays open while another is looked at.
  private var tabs: some View {
    TabView(selection: $tab) {
      Tab("Projects", systemImage: "square.stack.3d.up", value: "agents") { agents }
      Tab("Folders", systemImage: "folder", value: "folders") { folders }
      Tab("Settings", systemImage: "gearshape", value: "settings") { SettingsView(model: model, importing: $importing) }
    }
    .tabBarMinimizeBehavior(.onScrollDown)
  }

  private var agents: some View {
    NavigationStack(path: $path) {
      HomeView(model: model, path: $path, notice: $notice, importing: $importing, hosts: { tab = "settings" })
        .navigationDestination(for: Route.self) { route in screen(route, $path) }
    }
  }

  private var folders: some View {
    NavigationStack(path: $places) {
      PlacesView(model: model, path: $places).navigationDestination(for: Route.self) { route in screen(route, $places) }
    }
  }

  /// A screen opened from one of the three lists: the tabs are for the lists, and are not shown on it.
  private func screen(_ route: Route, _ path: Binding<[Route]>) -> some View {
    inside(route, path).toolbarVisibility(.hidden, for: .tabBar)
  }

  @ViewBuilder
  private func inside(_ route: Route, _ path: Binding<[Route]>) -> some View {
    switch route {
    case .agent(let key): AgentScreen(model: model, key: key, path: path, open: open)
    case .plots(let key, let file): PlotsScreen(model: model, key: key, open: open, file: file)
    case .review(let key): ReviewScreen(model: model, key: key, path: path, open: open)
    case .project(let id): ProjectScreen(model: model, id: id, path: path, notice: $notice)
    case .files(let host, let dir): FolderScreen(model: model, host: host, dir: dir, path: path)
    }
  }

  /// An export from the Mac: a file opened with Kuna (`home`: back to the projects), or picked in the app.
  private func take(_ url: URL, home: Bool) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    do {
      let text = try String(contentsOf: url, encoding: .utf8)
      notice = Notice(title: "Imported", text: "\(try model.importFile(text)) from your Mac. Add this phone's key to the hosts, or type their passwords, under Settings.")
      if home {
        path = []
        tab = "agents"
      }
    } catch {
      notice = Notice(title: "Could not import", text: error.localizedDescription)
    }
  }
}

private struct LockScreen: View {
  let unlock: () -> Void
  @Environment(\.look) private var look

  var body: some View {
    ZStack {
      look.ground.ignoresSafeArea()
      VStack(spacing: 18) {
        Image(systemName: "lock.fill").font(.system(size: 34)).foregroundStyle(look.dim)
        Text("Kuna is locked").font(.title3.weight(.semibold)).foregroundStyle(look.text)
        Button("Unlock", action: unlock).buttonStyle(.borderedProminent)
      }
    }
  }
}
#endif
