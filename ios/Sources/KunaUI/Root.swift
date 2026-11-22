#if os(iOS)
import KunaCore
import LocalAuthentication
import SwiftUI

enum Route: Hashable {
  case agent(String)
  case plots(String)
  case review(String)
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
  @State private var path: [Route] = []
  @State private var locked = UserDefaults.standard.object(forKey: "lock") as? Bool ?? true
  @State private var left: Date?
  @State private var notice: Notice?
  @State private var open = OpenAgents()
  @Environment(\.scenePhase) private var scene
  @AppStorage("lock") private var lock = true

  public init() {}

  public var body: some View {
    let look = Look(model.theme)
    NavigationStack(path: $path) {
      HomeView(model: model, path: $path, notice: $notice)
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .agent(let key): AgentScreen(model: model, key: key, path: $path, open: open)
          case .plots(let key): PlotsScreen(model: model, key: key, open: open)
          case .review(let key): ReviewScreen(model: model, key: key, path: $path, open: open)
          }
        }
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
    .onOpenURL { take($0) }
    .onChange(of: path) { _, now in
      open.keep(only: Set(now.map { route in
        switch route {
        case .agent(let key), .plots(let key), .review(let key): key
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

  /// A file opened with Kuna: an export from the Mac.
  private func take(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    do {
      let text = try String(contentsOf: url, encoding: .utf8)
      notice = Notice(title: "Imported", text: "\(try model.importFile(text)) from your Mac. Add this phone's key to the hosts, or type their passwords, under Hosts.")
      path = []
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
