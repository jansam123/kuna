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

/// One group of the viewer's list, as on the Mac: Slides, Diagrams, Plots, Markdown, Pages; PDFs not read yet.
struct MediaGroup: Decodable, Identifiable {
  let id: String
  let label: String
  /// its own colour; none takes the scheme's dim
  let color: String?
  let items: [MediaItem]

  /// its mark: a screen on its stand, boxes and a line, axes and a curve, a page, a tag
  var symbol: String {
    switch id {
    case "slides": "tv"
    case "diagram": "rectangle.connected.to.line.below"
    case "plot": "chart.xyaxis.line"
    case "md": "doc.text"
    case "html": "chevron.left.forwardslash.chevron.right"
    case "url": "globe"
    default: "doc"
    }
  }
}

/// The files of one agent: which there are, and their contents once fetched.
@MainActor @Observable
final class MediaStore {
  private(set) var items: [MediaItem] = [] { didSet { regroup() } }
  /// the files by group, in the Mac's order: what the list shows and the order the viewer swipes through
  private(set) var groups: [MediaGroup] = []
  /// what the PDFs read so far are (slides, diagram, plot), by path
  private var classes: [String: String] = [:] { didSet { regroup() } }
  @ObservationIgnored private var read: Set<String> = []
  @ObservationIgnored private var base = ""
  /// a PDF up to this size is read by itself to learn what it is; a larger one stays under PDFs until opened
  static let classifyBelow = 4.0 * 1024 * 1024
  private(set) var loading = false
  private(set) var problem: String?
  /// the folder has been looked through, not only what the conversation mentioned
  private(set) var scanned = false
  @ObservationIgnored private var cache: [String: Data] = [:]
  @ObservationIgnored private var order: [String] = []
  /// files saved from the phone: what they hold now, and when the host says they were changed
  private var saved: [String: (data: Data, mtime: Double)] = [:]
  var edited: Bool { !saved.isEmpty }
  /// past this a file is not edited on the phone
  static let editBelow = 400.0 * 1024

  /// past this a file is not shown at all
  static let most = 200.0 * 1024 * 1024
  /// past this a file that is not a picture, a PDF or a page is not shown as text (it can still be downloaded)
  static let textBelow = 2.0 * 1024 * 1024
  /// past this, on mobile data, the user is asked first
  static let askAbove = 25.0 * 1024 * 1024

  private func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

  /// What the agent's replies mentioned, newest reply first; the folder itself when they mentioned nothing.
  func load(model: AppModel, session: AgentSession, agent: Agent) async {
    loading = true
    problem = nil
    base = agent.base
    defer {
      loading = false
      Task { await classify(model: model, host: agent.host) }
    }
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
      base = agent.base
      items += scan.filter { !have.contains($0.path) }
      scanned = true
      Task { await classify(model: model, host: agent.host) }
    } catch {
      problem = error.localizedDescription
    }
  }

  private func regroup() {
    groups = (try? Shared.main.decode([MediaGroup].self, "mediaGroups", [json(items), json(classes), base])) ?? []
  }

  func group(of item: MediaItem) -> MediaGroup? { groups.first { $0.items.contains { $0.path == item.path } } }

  /// A PDF's pages and who made it say what it is, as on the Mac (`figureClass`).
  private func learn(_ item: MediaItem, _ data: Data) {
    guard item.kind == "pdf", self.read.insert("\(item.path)\n\(item.stamp)").inserted, let doc = PDFDocument(data: data) else { return }
    let made = doc.documentAttributes
    let maker = "\(made?[PDFDocumentAttribute.creatorAttribute] as? String ?? "") \(made?[PDFDocumentAttribute.producerAttribute] as? String ?? "")"
    if let figure = try? Shared.main.call("figure", [item.path, doc.pageCount, maker]) { classes[item.path] = figure }
  }

  /// Reads the small PDFs, one at a time, so each stands under what it is: slides, a diagram or a plot.
  private func classify(model: AppModel, host: String) async {
    let limit = Connection.expensive ? Self.classifyBelow / 4 : Self.classifyBelow
    for item in items where item.kind == "pdf" && item.size <= limit && !read.contains("\(item.path)\n\(item.stamp)") {
      _ = try? await data(for: item, host: host, model: model)
    }
  }

  /// What a file holds since it was saved from here, unless the host has listed a newer one since.
  func saved(_ item: MediaItem) -> Data? {
    guard let mine = saved[item.path], item.mtime <= mine.mtime else { return nil }
    return mine.data
  }

  /// Save a file edited on the phone: refused by the host when someone else wrote it since it was read.
  func save(_ item: MediaItem, text: String, host: String, model: AppModel) async throws {
    let mtime = try await model.write(host, path: item.path, text: text, mtime: saved[item.path]?.mtime ?? item.mtime)
    saved[item.path] = (Data(text.utf8), mtime)
  }

  func data(for item: MediaItem, host: String, model: AppModel) async throws -> Data {
    if let mine = saved(item) { return mine }
    let key = "\(host)\n\(item.path)\n\(item.stamp)"
    if let hit = cache[key] { return hit }
    guard item.size <= Self.most else { throw KunaError("\(item.name) is \(sizeText(item.size)): too large to show on the phone.") }
    let read = try await model.run(host, ["cat", b64(item.path)], timeout: 120 + item.size / 1024 / 1024 * 4)
    guard read.code == 0 else { throw KunaError(read.stderr.isEmpty ? "Could not read \(item.name)." : read.stderr) }
    cache[key] = read.stdout
    learn(item, read.stdout)
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
  /// the groups rolled out: each starts rolled up
  @State private var unrolled: Set<String> = []

  var body: some View {
    let agent = model.agent(key)
    let here = open.get(key, model)
    VStack(spacing: 0) {
      list(agent)
      PromptDrawer(model: model, here: here)
    }
    .background(look.ground)
    .navigationTitle("Plots and files")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { PromptButton(here: here) }
    .task { await reload() }
    .inPlace($showing) { item in
      if let agent {
        ViewerScreen(model: model, store: store, host: agent.host, items: store.groups.flatMap(\.items), start: item, agent: here) { showing = nil }
      }
    }
  }

  private func list(_ agent: Agent?) -> some View {
    List {
      if let problem = store.problem { Text(problem).foregroundStyle(look.danger).listRowBackground(look.panel) }
      ForEach(store.groups) { group in
        let unfolded = unrolled.contains(group.id)
        Section {
          if unfolded {
            ForEach(group.items) { item in
              Button { showing = item } label: { MediaRow(item: item, base: agent?.base ?? "") }
                .listRowBackground(look.panel)
                .accessibilityIdentifier("media-\(item.name)")
            }
          }
        } header: {
          Button { unrolled.formSymmetricDifference([group.id]) } label: {
            HStack(spacing: 8) {
              Image(systemName: group.symbol).foregroundStyle(group.color.map { Color(hex: $0) } ?? look.dim).frame(width: 22)
              Text(group.label).foregroundStyle(look.text)
              Text("\(group.items.count)").monospacedDigit().foregroundStyle(look.dim)
              Spacer()
              Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(look.faint).rotationEffect(.degrees(unfolded ? 90 : 0))
            }
            .font(.subheadline.weight(.semibold))
            .textCase(nil)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("group-\(group.id)")
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
    .refreshable { await reload() }
  }

  private func reload() async {
    guard let agent = model.agent(key) else { return }
    Connection.start()
    await store.load(model: model, session: open.get(key, model).session, agent: agent)
  }
}

private struct MediaRow: View {
  let item: MediaItem
  let base: String
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 10) {
      PlaceChip(place: item.place ?? "outside")
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
        if !folder.isEmpty { Text(folder).font(.caption).foregroundStyle(look.dim).lineLimit(1).truncationMode(.head) }
      }
      Spacer(minLength: 4)
      VStack(alignment: .trailing, spacing: 2) {
        Text(ago(item.mtime)).font(.caption.monospacedDigit()).foregroundStyle(look.faint)
        Text(sizeText(item.size)).font(.caption2.monospacedDigit()).foregroundStyle(look.faint)
      }
    }
  }

  /// its folder, from the agent's own folder when it is inside it
  private var folder: String {
    let dir = String(item.path.dropLast(item.name.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let root = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if dir == root { return "" }
    if dir.hasPrefix(root + "/") { return String(dir.dropFirst(root.count + 1)) }
    return "/" + dir
  }
}

/// Where a file lives, in a word, as the Mac's list marks it: outside the agent's folder reads plain, the other places stand out.
struct PlaceChip: View {
  let place: String
  @Environment(\.look) private var look

  var body: some View {
    let color: Color? = switch place {
    case "claude": look.insert
    case "tmp": look.waiting
    case "folder": look.unread
    default: nil
    }
    Text(place == "claude" ? ".claude" : place).font(.caption2.monospaced()).foregroundStyle(color ?? look.faint).padding(.horizontal, 5).padding(.vertical, 2)
      .background((color ?? .clear).opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
      .frame(minWidth: 52, alignment: .leading)
  }
}

/// One file in view, the others a swipe away. A file of text can be edited here and saved back
/// to the host; the editor stays as it is while another tab is looked at.
struct ViewerScreen: View {
  let model: AppModel
  let store: MediaStore
  let host: String
  let items: [MediaItem]
  /// the agent whose files these are, to write to while looking at them
  var agent: OpenAgents.Open?
  let close: () -> Void
  @State var current: String
  @Environment(\.look) private var look
  @State private var shared: URL?
  @State private var saving: URL?
  @State private var failure: Notice?
  /// the text being edited, and the file it is
  @State private var editing: String?
  @State private var busy = false
  @State private var area = TextArea.Handle()

  init(model: AppModel, store: MediaStore, host: String, items: [MediaItem], start: MediaItem, agent: OpenAgents.Open? = nil, close: @escaping () -> Void) {
    self.agent = agent
    self.close = close
    self.model = model
    self.store = store
    self.host = host
    self.items = items
    _current = State(initialValue: start.id)
  }

  var body: some View {
    let index = items.firstIndex { $0.id == current } ?? 0
    let item = items[index]
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        if editing != nil {
          Button("Cancel") { editing = nil }.accessibilityIdentifier("edit-cancel")
        } else {
          Button("Done", action: close).fontWeight(.semibold).accessibilityIdentifier("viewer-done")
          if let group = store.group(of: item) {
            Image(systemName: group.symbol).foregroundStyle(group.color.map { Color(hex: $0) } ?? look.dim).accessibilityLabel(group.label)
          }
        }
        VStack(alignment: .leading, spacing: 1) {
          Text(item.name).font(.subheadline.weight(.semibold)).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
          Text(editing != nil ? "editing · \(host)" : "\(index + 1) of \(items.count) · \(sizeText(item.size)) · \(ago(item.mtime))").font(.caption2).foregroundStyle(look.dim)
        }
        if editing == nil, let place = item.place { PlaceChip(place: place) }
        Spacer(minLength: 0)
        if let agent { PromptButton(here: agent) }
        if editing != nil {
          Button("Keyboard", systemImage: "keyboard") { area.toggleKeyboard() }.labelStyle(.iconOnly).accessibilityIdentifier("edit-keyboard")
          if busy { ProgressView() } else { Button("Save") { save(item) }.fontWeight(.semibold).accessibilityIdentifier("edit-save") }
        } else {
          if ["file", "md", "html", "svg"].contains(item.kind) {
            Button("Edit", systemImage: "pencil") { edit(item) }.labelStyle(.iconOnly).disabled(busy).accessibilityIdentifier("viewer-edit")
          }
          Button("Download", systemImage: "arrow.down.to.line") {
            Task {
              do { saving = try phoneCopy(of: try await store.data(for: item, host: host, model: model), named: item.name) } catch {
                failure = Notice(title: "Not downloaded", text: error.localizedDescription)
              }
            }
          }
          .labelStyle(.iconOnly).accessibilityIdentifier("viewer-download")
          if let shared { ShareLink(item: shared) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share") }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(look.panel)
      if editing != nil {
        TextArea(text: Binding(get: { editing ?? "" }, set: { editing = $0 }), editable: true, handle: area).background(look.ground).accessibilityIdentifier("editor")
      } else {
        TabView(selection: $current) {
          ForEach(items) { item in
            MediaPage(model: model, store: store, host: host, item: item, front: item.id == current) { shared = $0 }.tag(item.id)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(look.ground)
      }
      if let agent { PromptDrawer(model: model, here: agent) }
    }
    .background(look.panel.ignoresSafeArea())
    .onChange(of: current) { shared = nil }
    .fileMover(isPresented: Binding(get: { saving != nil }, set: { if !$0 { saving = nil } }), file: saving) { _ in saving = nil }
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
  }

  /// Open the file's text to edit: only text, and not more of it than a phone edits well.
  private func edit(_ item: MediaItem) {
    guard item.size <= MediaStore.editBelow else {
      failure = Notice(title: "Too large to edit here", text: "\(item.name) is \(sizeText(item.size)). Files up to \(sizeText(MediaStore.editBelow)) are edited on the phone.")
      return
    }
    busy = true
    Task {
      defer { busy = false }
      do {
        let data = try await store.data(for: item, host: host, model: model)
        // a file that is not UTF-8 would be saved back as something else
        guard !data.contains(0), let text = String(data: data, encoding: .utf8) else {
          failure = Notice(title: "Not edited here", text: "\(item.name) is not plain text in UTF-8.")
          return
        }
        editing = text
      } catch {
        failure = Notice(title: "Could not read it", text: error.localizedDescription)
      }
    }
  }

  private func save(_ item: MediaItem) {
    guard let text = editing else { return }
    busy = true
    Task {
      do {
        try await store.save(item, text: text, host: host, model: model)
        hideKeyboard()
        editing = nil
      } catch {
        // what was written stays in the editor
        failure = Notice(title: "Not saved", text: error.localizedDescription)
      }
      busy = false
    }
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
        // what was saved from the phone since is what the file holds now
        shown(store.saved(item) ?? data)
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
          if item.kind != "file" || item.size <= MediaStore.textBelow { Button("Try again") { Task { await fetch() } }.buttonStyle(.bordered) }
        }
      } else {
        ProgressView()
      }
    }
    .task(id: front) {
      guard front, data == nil, problem == nil else { return }
      if item.kind == "file", item.size > MediaStore.textBelow {
        problem = "\(item.name) is \(sizeText(item.size)): too large to show as text. The arrow above downloads it."
      } else if item.size > MediaStore.askAbove, Connection.expensive { asking = true } else { await fetch() }
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
    case "file":
      if data.prefix(8000).contains(0) {
        Text("This is a binary file. The arrow above downloads it.").foregroundStyle(look.dim).multilineTextAlignment(.center).padding(28)
      } else {
        WebPane(model: model, host: host, dir: dir, content: .code(path: item.path, text: String(decoding: data, as: UTF8.self)))
      }
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
