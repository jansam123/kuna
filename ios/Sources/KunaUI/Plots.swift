#if os(iOS)
import KunaCore
import Network
import PDFKit
import SwiftUI

/// Whether the phone is on a connection that costs (mobile data, a hotspot).
@MainActor
enum Connection {
  private static let monitor: NWPathMonitor = {
    let monitor = NWPathMonitor()
    monitor.start(queue: .global(qos: .utility))
    return monitor
  }()
  static var expensive: Bool { monitor.currentPath.isExpensive }
  static func start() { _ = monitor }
}

/// The files of one agent: which there are, and their contents once fetched.
@MainActor @Observable
final class MediaStore {
  private(set) var items: [MediaItem] = []
  private(set) var loading = false
  private(set) var problem: String?
  /// the folder has been looked through, not only what the conversation mentioned
  private(set) var scanned = false
  @ObservationIgnored private var cache: [String: Data] = [:]
  @ObservationIgnored private var order: [String] = []

  /// past this a file is not shown at all
  static let most = 200.0 * 1024 * 1024
  /// past this, on mobile data, the user is asked first
  static let askAbove = 25.0 * 1024 * 1024

  private func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

  /// What the agent's replies mentioned, newest reply first; the folder itself when they mentioned nothing.
  func load(model: AppModel, session: AgentSession, agent: Agent) async {
    loading = true
    problem = nil
    defer { loading = false }
    await session.pull()
    let paths = session.mentionedFiles()
    if !paths.isEmpty {
      do {
        let stat = try await model.done(agent.host, ["stat", b64(paths.joined(separator: "\n"))], timeout: 25, or: "Could not look at the files.")
        items = (try? Shared.main.decode([MediaItem].self, "mediaItems", [stat.text, json(paths)])) ?? []
      } catch {
        problem = error.localizedDescription
      }
    }
    if items.isEmpty, problem == nil { await scan(model: model, agent: agent) }
  }

  /// Every picture, PDF, Markdown file and page written in the agent's folder since it started.
  func scan(model: AppModel, agent: Agent) async {
    loading = true
    problem = nil
    defer { loading = false }
    var args = ["media", agent.agentId, b64(agent.base)]
    if agent.isBackground { args.append(String(max(5, Int((Date().timeIntervalSince1970 - agent.createdAt) / 60) + 2))) }
    do {
      let found = try await model.done(agent.host, args, timeout: 40, or: "Could not look through the folder.")
      let scan = (try? Shared.main.decode([MediaItem].self, "mediaItems", [found.text, "[]"])) ?? []
      let have = Set(items.map(\.path))
      items += scan.filter { !have.contains($0.path) }
      scanned = true
    } catch {
      problem = error.localizedDescription
    }
  }

  func data(for item: MediaItem, host: String, model: AppModel) async throws -> Data {
    let key = "\(host)\n\(item.path)\n\(item.stamp)"
    if let hit = cache[key] { return hit }
    guard item.size <= Self.most else { throw KunaError("\(item.name) is \(sizeText(item.size)): too large to show on the phone.") }
    let read = try await model.run(host, ["cat", b64(item.path)], timeout: 120 + item.size / 1024 / 1024 * 4)
    guard read.code == 0 else { throw KunaError(read.stderr.isEmpty ? "Could not read \(item.name)." : read.stderr) }
    cache[key] = read.stdout
    order.append(key)
    // a few files stay for going back and forth
    while order.count > 10 || cache.values.reduce(0, { $0 + $1.count }) > 150 * 1024 * 1024, order.count > 1 { cache[order.removeFirst()] = nil }
    return read.stdout
  }
}

/// What an agent made: its plots, PDFs, notes and pages, to look at one by one.
struct PlotsScreen: View {
  let model: AppModel
  let key: String
  let open: OpenAgents
  @Environment(\.look) private var look
  @State private var store = MediaStore()
  @State private var showing: MediaItem?

  var body: some View {
    let agent = model.agent(key)
    List {
      if let problem = store.problem { Text(problem).foregroundStyle(look.danger).listRowBackground(look.panel) }
      ForEach(groups, id: \.0) { title, items in
        Section(title) {
          ForEach(items) { item in
            Button { showing = item } label: { MediaRow(item: item, base: agent?.base ?? "") }
              .listRowBackground(look.panel)
              .accessibilityIdentifier("media-\(item.name)")
          }
        }
      }
      if !store.loading, store.items.isEmpty, store.problem == nil {
        Text("No pictures, PDFs, Markdown files or pages yet. They show up once the agent writes or mentions one.").foregroundStyle(look.dim).listRowBackground(look.panel)
      }
      if let agent, !store.scanned, !store.loading {
        Button("Look through its folder too", systemImage: "folder.badge.questionmark") { Task { await store.scan(model: model, agent: agent) } }
          .listRowBackground(look.panel)
      }
      if store.loading { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear) }
    }
    .scrollContentBackground(.hidden)
    .background(look.ground)
    .navigationTitle("Plots and files")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await reload() }
    .task { await reload() }
    .fullScreenCover(item: $showing) { item in
      if let agent { ViewerScreen(model: model, store: store, host: agent.host, items: store.items, start: item).environment(\.look, look) }
    }
  }

  private func reload() async {
    guard let agent = model.agent(key) else { return }
    Connection.start()
    await store.load(model: model, session: open.get(key, model).session, agent: agent)
  }

  private var groups: [(String, [MediaItem])] {
    let names = ["pdf": "PDFs", "image": "Pictures", "svg": "Pictures", "md": "Markdown", "html": "Pages"]
    var out: [(String, [MediaItem])] = []
    for item in store.items {
      let title = names[item.kind] ?? "Files"
      if let i = out.firstIndex(where: { $0.0 == title }) { out[i].1.append(item) } else { out.append((title, [item])) }
    }
    return out
  }
}

private struct MediaRow: View {
  let item: MediaItem
  let base: String
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: icon).font(.title3).foregroundStyle(look.accent).frame(width: 30)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
        Text(place).font(.caption).foregroundStyle(look.dim).lineLimit(1).truncationMode(.head)
      }
      Spacer(minLength: 4)
      VStack(alignment: .trailing, spacing: 2) {
        Text(ago(item.mtime)).font(.caption.monospacedDigit()).foregroundStyle(look.faint)
        Text(sizeText(item.size)).font(.caption2.monospacedDigit()).foregroundStyle(look.faint)
      }
    }
  }

  private var icon: String {
    switch item.kind {
    case "pdf": "doc.richtext"
    case "md": "text.alignleft"
    case "html": "globe"
    default: "photo"
    }
  }

  /// its folder, from the agent's own folder when it is inside it
  private var place: String {
    let dir = String(item.path.dropLast(item.name.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let root = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if dir == root { return "in its folder" }
    if dir.hasPrefix(root + "/") { return String(dir.dropFirst(root.count + 1)) }
    return "/" + dir
  }
}

/// One file full screen; swipe sideways for the next.
struct ViewerScreen: View {
  let model: AppModel
  let store: MediaStore
  let host: String
  let items: [MediaItem]
  @State var current: String
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var shared: URL?

  init(model: AppModel, store: MediaStore, host: String, items: [MediaItem], start: MediaItem) {
    self.model = model
    self.store = store
    self.host = host
    self.items = items
    _current = State(initialValue: start.id)
  }

  var body: some View {
    let index = items.firstIndex { $0.id == current } ?? 0
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button("Done") { dismiss() }.fontWeight(.semibold).accessibilityIdentifier("viewer-done")
        VStack(alignment: .leading, spacing: 1) {
          Text(items[index].name).font(.subheadline.weight(.semibold)).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
          Text("\(index + 1) of \(items.count) · \(sizeText(items[index].size)) · \(ago(items[index].mtime))").font(.caption2).foregroundStyle(look.dim)
        }
        Spacer(minLength: 0)
        if let shared { ShareLink(item: shared) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share") }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(look.panel)
      TabView(selection: $current) {
        ForEach(items) { item in
          MediaPage(model: model, store: store, host: host, item: item, front: item.id == current) { shared = $0 }.tag(item.id)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .background(look.ground)
    }
    .background(look.panel.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .onChange(of: current) { shared = nil }
  }
}

private struct MediaPage: View {
  let model: AppModel
  let store: MediaStore
  let host: String
  let item: MediaItem
  /// the page in view (its neighbours are made too, but only this one fetches)
  let front: Bool
  let share: (URL?) -> Void
  @Environment(\.look) private var look
  @State private var data: Data?
  @State private var problem: String?
  @State private var asking = false

  var body: some View {
    ZStack {
      look.ground
      if let data {
        shown(data)
      } else if asking {
        VStack(spacing: 14) {
          Text("\(item.name) is \(sizeText(item.size)).").foregroundStyle(look.text)
          Text("You are on mobile data.").font(.footnote).foregroundStyle(look.dim)
          Button("Load it") {
            asking = false
            Task { await fetch() }
          }
          .buttonStyle(.borderedProminent)
        }
      } else if let problem {
        VStack(spacing: 12) {
          Text(problem).foregroundStyle(look.dim).multilineTextAlignment(.center).padding(.horizontal, 28)
          Button("Try again") { Task { await fetch() } }.buttonStyle(.bordered)
        }
      } else {
        ProgressView()
      }
    }
    .task(id: front) {
      guard front, data == nil else { return }
      if item.size > MediaStore.askAbove, Connection.expensive { asking = true } else { await fetch() }
    }
  }

  private func fetch() async {
    problem = nil
    do {
      let got = try await store.data(for: item, host: host, model: model)
      data = got
      if front {
        // a copy with the file's own name, for the share sheet
        let dir = FileManager.default.temporaryDirectory.appending(path: "kuna-share")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appending(path: item.name)
        try? got.write(to: file)
        share(file)
      }
    } catch {
      problem = error.localizedDescription
    }
  }

  @ViewBuilder
  private func shown(_ data: Data) -> some View {
    let dir = String(item.path.dropLast(item.name.count + 1))
    switch item.kind {
    case "pdf":
      if let document = PDFDocument(data: data) { PDFPane(document: document, ground: UIColor(look.ground)) } else { Text("This PDF could not be opened.").foregroundStyle(look.dim) }
    case "md": WebPane(model: model, host: host, dir: dir, content: .markdown(String(decoding: data, as: UTF8.self)))
    case "svg": WebPane(model: model, host: host, dir: dir, content: .svg(data))
    case "html": WebPane(model: model, host: host, dir: dir, content: .page(item.name))
    default:
      if let image = UIImage(data: data) { ZoomPane(image: image) } else { Text("This picture could not be opened.").foregroundStyle(look.dim) }
    }
  }
}

private struct PDFPane: UIViewRepresentable {
  let document: PDFDocument
  let ground: UIColor

  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.autoScales = true
    view.displayMode = .singlePageContinuous
    view.displayDirection = .vertical
    view.backgroundColor = ground
    view.document = document
    return view
  }

  func updateUIView(_ view: PDFView, context: Context) {
    if view.document !== document { view.document = document }
  }
}

/// A picture that can be pinched and dragged; a double tap goes in and back out.
private struct ZoomPane: UIViewRepresentable {
  let image: UIImage

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UIScrollView {
    let scroll = UIScrollView()
    scroll.delegate = context.coordinator
    scroll.maximumZoomScale = 8
    scroll.minimumZoomScale = 1
    scroll.showsVerticalScrollIndicator = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.contentInsetAdjustmentBehavior = .never
    let picture = UIImageView(image: image)
    picture.contentMode = .scaleAspectFit
    picture.frame = scroll.bounds
    picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scroll.addSubview(picture)
    context.coordinator.picture = picture
    let twice = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.twice(_:)))
    twice.numberOfTapsRequired = 2
    scroll.addGestureRecognizer(twice)
    return scroll
  }

  func updateUIView(_ scroll: UIScrollView, context: Context) {
    if context.coordinator.picture?.image !== image { context.coordinator.picture?.image = image }
  }

  final class Coordinator: NSObject, UIScrollViewDelegate {
    weak var picture: UIImageView?
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
    @objc func twice(_ tap: UITapGestureRecognizer) {
      guard let scroll = tap.view as? UIScrollView else { return }
      if scroll.zoomScale > 1.01 {
        scroll.setZoomScale(1, animated: true)
      } else {
        let at = tap.location(in: picture)
        let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
        scroll.zoom(to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height), animated: true)
      }
    }
  }
}
#endif
