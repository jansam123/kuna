#if os(iOS)
import KunaCore
import SwiftUI

// The shapes src/shared/git.ts gives (through ios/bridge.ts).

struct GitRepo: Decodable, Identifiable, Hashable {
  var path: String
  var label: String
  var branch: String?
  var head: String?
  var id: String { path }
}

struct FileChange: Decodable, Identifiable, Hashable {
  var path: String
  var oldPath: String?
  /// A added, M modified, D deleted, R renamed, C copied, T type changed, U in conflict, ? untracked
  var kind: String
  var added: Int?
  var removed: Int?
  var binary: Bool?
  var id: String { kind + path }
  var name: String { path.split(separator: "/").last.map(String.init) ?? path }
  var folder: String { path.contains("/") ? String(path.dropLast(name.count + 1)) : "" }
}

struct GitRef: Decodable, Hashable {
  var short: String
  var kind: String
}

struct GitInfo: Decodable, Hashable {
  var root: String
  var branch: String?
  var head: String?
  var refs: [GitRef]
}

struct GitOverview: Decodable, Hashable {
  var info: GitInfo
  var base: String?
  var staged: [FileChange]
  var unstaged: [FileChange]
}

struct GitCommit: Decodable, Identifiable, Hashable {
  var sha: String
  var short: String
  var author: String
  var time: Double
  var subject: String
  var id: String { sha }
}

struct GitCompare: Decodable, Hashable {
  var base: String
  var mergeBase: String
  var head: String?
  var tip: String
  var files: [FileChange]
  var commits: [GitCommit]
}

/// One side of a diff, as `kuna git cat` names it.
enum GitSide: Hashable {
  case rev(String, String)
  case index(String)
  case worktree(String)
  case empty

  var spec: String? {
    switch self {
    case .rev(let rev, let path): "G\(rev):\(path)"
    case .index(let path): "I\(path)"
    case .worktree(let path): "W\(path)"
    case .empty: nil
    }
  }
}

/// A file to show as a diff: what it was, what it is, and how to say which diff this is.
struct DiffTarget: Identifiable, Hashable {
  var change: FileChange
  var old: GitSide
  var new: GitSide
  /// which diff a comment was written on, and that diff in words for the agent
  var anchor: String
  var context: String
  var id: String { anchor + change.id }
}

/// A comment on a line (`ReviewComment` in src/shared/git.ts).
struct ReviewComment: Codable, Identifiable, Hashable {
  var id = UUID().uuidString
  var path: String
  var side: String
  var start: Int
  var end: Int
  var text: String
  var code: [String]
  var anchor: String
  var context: String
}

/// The comments written on an agent's changes and not yet sent to it.
@MainActor @Observable
final class ReviewDraft {
  var comments: [ReviewComment] = []
}

/// Git on the agent's host: read-only, through the helper's `git` commands.
@MainActor @Observable
final class ReviewStore {
  let model: AppModel
  let host: String
  /// the agent's folder
  let dir: String
  private(set) var repos: [GitRepo] = []
  var repo: GitRepo?
  private(set) var overview: GitOverview?
  private(set) var compare: GitCompare?
  private(set) var commits: [GitCommit] = []
  /// the commits are the newest of the branch itself, there being none that the base lacks
  private(set) var latest = false
  private(set) var files: [String] = []
  var base = ""
  private(set) var loading = false
  private(set) var problem: String?

  /// the most of one side of a diff the phone reads
  static let maxBlob = 2 * 1024 * 1024

  init(model: AppModel, host: String, dir: String) {
    self.model = model
    self.host = host
    self.dir = dir
  }

  private func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

  private func git(_ args: [String], timeout: TimeInterval = 45) async throws -> ExecResult {
    try await model.done(host, ["git"] + args, timeout: timeout, or: "git did not answer.")
  }

  func load() async {
    loading = true
    problem = nil
    defer { loading = false }
    do {
      if repos.isEmpty {
        repos = try Shared.main.decode([GitRepo].self, "gitRepos", [try await git(["repos", b64(dir)], timeout: 30).text, dir])
        repo = repo ?? repos.first
      }
      guard let repo else { return }
      async let info = git(["info", b64(repo.path)], timeout: 25)
      async let status = git(["status", b64(repo.path)], timeout: 35)
      let seen = try Shared.main.decode(GitOverview.self, "gitOverview", [try await info.text, try await status.text])
      overview = seen
      if base.isEmpty || !seen.info.refs.contains(where: { $0.short == base }) { base = seen.base ?? "" }
      await loadCompare()
    } catch {
      problem = error.localizedDescription
    }
  }

  /// The branch against its base: its files (uncommitted ones included) and its commits.
  func loadCompare() async {
    guard let repo else { return }
    compare = nil
    commits = []
    latest = false
    do {
      if !base.isEmpty {
        let seen = try Shared.main.decode(GitCompare.self, "gitCompare", [try await git(["compare", b64(repo.path), b64(base), ""]).text, base, ""])
        compare = seen
        commits = seen.commits
      }
      if commits.isEmpty, overview?.info.head != nil {
        // on the base branch itself, or with no base at all: the branch's own latest commits
        for back in [20, 5, 1] {
          guard let out = try? await git(["compare", b64(repo.path), b64("HEAD~\(back)"), b64("HEAD")]) else { continue }
          commits = (try? Shared.main.decode(GitCompare.self, "gitCompare", [out.text, "HEAD~\(back)", "HEAD"]).commits) ?? []
          latest = true
          break
        }
      }
    } catch {
      problem = error.localizedDescription
    }
  }

  func loadFiles() async {
    guard let repo, files.isEmpty else { return }
    if let out = try? await git(["files", b64(repo.path), ""]) { files = (try? Shared.main.decode([String].self, "gitFiles", [out.text])) ?? [] }
  }

  /// What one commit changed.
  func commit(_ commit: GitCommit) async throws -> GitCompare {
    guard let repo else { throw KunaError("No repository.") }
    let out = try await git(["compare", b64(repo.path), b64("\(commit.sha)^"), b64(commit.sha)])
    return try Shared.main.decode(GitCompare.self, "gitCompare", [out.text, "\(commit.sha)^", commit.sha])
  }

  /// Both sides of a diff in one round trip: each the file's bytes, `nil` when it is not there, or why it is not shown.
  func read(_ sides: [GitSide]) async throws -> [Result<Data?, KunaError>] {
    guard let repo else { throw KunaError("No repository.") }
    let specs = sides.compactMap(\.spec)
    var blobs: [Result<Data?, KunaError>] = []
    if !specs.isEmpty {
      let out = try await git(["cat", b64(repo.path), String(Self.maxBlob)] + specs.map(b64), timeout: 120)
      blobs = Self.blobs(out.stdout)
    }
    var next = blobs.makeIterator()
    return sides.map { $0.spec == nil ? .success(Data()) : (next.next() ?? .success(nil)) }
  }

  /// `kuna git cat`: per file `\x1e<size>\x1e` and that many bytes, `\x1e+<size>\x1e` when larger than asked for, `\x1e-\x1e` when it is not there.
  static func blobs(_ data: Data) -> [Result<Data?, KunaError>] {
    var out: [Result<Data?, KunaError>] = []
    var at = data.startIndex
    while at < data.endIndex, data[at] == 0x1e, let close = data[data.index(after: at)...].firstIndex(of: 0x1e) {
      let head = String(decoding: data[data.index(after: at)..<close], as: UTF8.self)
      at = data.index(after: close)
      if head == "-" {
        out.append(.success(nil))
      } else if head.hasPrefix("+") {
        out.append(.failure(KunaError("It is \(sizeText(Double(head.dropFirst()) ?? 0)): too large to show here.")))
      } else if let size = Int(head), size >= 0, data.distance(from: at, to: data.endIndex) >= size {
        out.append(.success(Data(data[at..<data.index(at, offsetBy: size)])))
        at = data.index(at, offsetBy: size)
      } else {
        break
      }
    }
    return out
  }
}

/// What an agent changed: the uncommitted changes, its branch against the base, single commits, any file.
struct ReviewScreen: View {
  let model: AppModel
  let key: String
  @Binding var path: [Route]
  let open: OpenAgents
  @Environment(\.look) private var look
  @State private var store: ReviewStore?
  @State private var tab = "changes"
  @State private var diff: DiffList?
  @State private var commit: CommitFiles?
  @State private var sending = false
  @State private var failure: Notice?

  struct DiffList: Identifiable {
    let id = UUID()
    var targets: [DiffTarget]
    var start: String
  }

  struct CommitFiles: Identifiable {
    var commit: GitCommit
    var compare: GitCompare
    var id: String { commit.sha }
  }

  var body: some View {
    let draft = open.get(key, model).review
    Group {
      if let store {
        content(store, draft)
      } else {
        ContentUnavailableView("This agent is gone", systemImage: "moon.zzz")
      }
    }
    .background(look.ground)
    .navigationTitle("Review")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      if store == nil, let agent = model.agent(key) {
        let made = ReviewStore(model: model, host: agent.host, dir: agent.base)
        store = made
        await made.load()
      }
    }
    .fullScreenCover(item: $diff) { list in
      if let store { DiffScreen(model: model, store: store, draft: draft, targets: list.targets, start: list.start).environment(\.look, look) }
    }
    .sheet(item: $commit) { shown in
      NavigationStack {
        List {
          Section {
            ForEach(shown.compare.files) { file in
              Button { show(targets(shown), file) } label: { ChangeRow(change: file) }.listRowBackground(look.panel)
            }
          } header: {
            Text("\(shown.commit.author) · \(Date(timeIntervalSince1970: shown.commit.time).formatted(date: .abbreviated, time: .shortened))")
          }
        }
        .scrollContentBackground(.hidden)
        .background(look.ground)
        .navigationTitle(shown.commit.subject)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { commit = nil } } }
      }
      .environment(\.look, look)
      .preferredColorScheme(.dark)
    }
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
  }

  @ViewBuilder
  private func content(_ store: ReviewStore, _ draft: ReviewDraft) -> some View {
    VStack(spacing: 0) {
      if store.repos.count > 1 {
        Picker("Repository", selection: Binding(get: { store.repo?.path ?? "" }, set: { picked in
          store.repo = store.repos.first { $0.path == picked }
          Task { await store.load() }
        })) {
          ForEach(store.repos) { Text($0.label).tag($0.path) }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
      }
      Picker("What to look at", selection: $tab) {
        Text("Changes").tag("changes")
        Text("Branch").tag("branch")
        Text("Commits").tag("commits")
        Text("Files").tag("files")
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      List {
        if let problem = store.problem { Text(problem).foregroundStyle(look.danger).listRowBackground(look.panel) }
        if store.loading, store.overview == nil { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear) }
        if !store.loading, store.repos.isEmpty, store.problem == nil {
          Text("There is no git repository in this agent's folder, or within three folders below it.").foregroundStyle(look.dim).listRowBackground(look.panel)
        }
        if let overview = store.overview {
          switch tab {
          case "changes": changes(store, overview)
          case "branch": branch(store, overview)
          case "commits": commits(store)
          default: FileTree(model: model, store: store)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .refreshable { await store.load() }
      if !draft.comments.isEmpty { outbox(draft) }
    }
    .onChange(of: tab) { if tab == "files" { Task { await store.loadFiles() } } }
  }

  /// what is not committed: the index against HEAD, then the folder against the index
  @ViewBuilder
  private func changes(_ store: ReviewStore, _ overview: GitOverview) -> some View {
    let staged = overview.staged.map { change in
      DiffTarget(
        change: change, old: change.kind == "A" ? .empty : .rev("HEAD", change.oldPath ?? change.path), new: change.kind == "D" ? .empty : .index(change.path), anchor: "staged",
        context: "the staged changes")
    }
    let unstaged = overview.unstaged.map { change in
      DiffTarget(
        change: change, old: change.kind == "?" ? .empty : .index(change.path), new: change.kind == "D" ? .empty : .worktree(change.path), anchor: "unstaged",
        context: "the uncommitted changes")
    }
    if staged.isEmpty, unstaged.isEmpty {
      Text("Nothing is changed since the last commit" + (overview.info.branch.map { " on \($0)." } ?? ".")).foregroundStyle(look.dim).listRowBackground(look.panel)
    }
    if !staged.isEmpty {
      Section("Staged") {
        ForEach(staged) { target in Button { show(staged, target.change) } label: { ChangeRow(change: target.change) }.listRowBackground(look.panel).accessibilityIdentifier("change-\(target.change.name)") }
      }
    }
    if !unstaged.isEmpty {
      Section("Changes") {
        ForEach(unstaged) { target in Button { show(unstaged, target.change) } label: { ChangeRow(change: target.change) }.listRowBackground(look.panel).accessibilityIdentifier("change-\(target.change.name)") }
      }
    }
  }

  /// the branch as a merge request would show it: everything since it left the base, uncommitted work included
  @ViewBuilder
  private func branch(_ store: ReviewStore, _ overview: GitOverview) -> some View {
    Section {
      Picker("Compared with", selection: Binding(get: { store.base }, set: { picked in
        store.base = picked
        Task { await store.loadCompare() }
      })) {
        if store.base.isEmpty { Text("Choose…").tag("") }
        ForEach(overview.info.refs.filter { $0.kind != "tag" }, id: \.short) { Text($0.short).tag($0.short) }
      }
      .listRowBackground(look.panel)
    } footer: {
      Text("\(overview.info.branch ?? "The checked-out commit") and what is not committed yet, since it left \(store.base.isEmpty ? "the branch you pick" : store.base).")
    }
    if let compare = store.compare {
      let targets = compare.files.map { change in
        DiffTarget(
          change: change, old: change.kind == "A" || change.kind == "?" ? .empty : .rev(compare.mergeBase, change.oldPath ?? change.path), new: change.kind == "D" ? .empty : .worktree(change.path),
          anchor: "branch:\(compare.mergeBase)", context: "`\(overview.info.branch ?? "the working tree")` compared with `\(store.base)`")
      }
      Section("\(targets.count) file\(targets.count == 1 ? "" : "s")") {
        if targets.isEmpty { Text("No differences.").foregroundStyle(look.dim).listRowBackground(look.panel) }
        ForEach(targets) { target in Button { show(targets, target.change) } label: { ChangeRow(change: target.change) }.listRowBackground(look.panel) }
      }
    } else if !store.base.isEmpty, store.problem == nil {
      HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
    }
  }

  @ViewBuilder
  private func commits(_ store: ReviewStore) -> some View {
    Section(store.latest ? "Latest commits" : "Commits since \(store.base)") {
      if store.commits.isEmpty { Text("No commits.").foregroundStyle(look.dim).listRowBackground(look.panel) }
      ForEach(store.commits) { one in
        Button {
          Task {
            do { commit = CommitFiles(commit: one, compare: try await store.commit(one)) } catch { failure = Notice(title: "Could not read the commit", text: error.localizedDescription) }
          }
        } label: {
          VStack(alignment: .leading, spacing: 3) {
            Text(one.subject).foregroundStyle(look.text).lineLimit(2)
            Text("\(one.short) · \(one.author) · \(ago(one.time))").font(.caption.monospaced()).foregroundStyle(look.dim).lineLimit(1)
          }
        }
        .listRowBackground(look.panel)
      }
    }
  }

  private func targets(_ shown: CommitFiles) -> [DiffTarget] {
    shown.compare.files.map { change in
      DiffTarget(
        change: change, old: change.kind == "A" ? .empty : .rev(shown.compare.mergeBase, change.oldPath ?? change.path), new: change.kind == "D" ? .empty : .rev(shown.commit.sha, change.path),
        anchor: "commit:\(shown.commit.sha)", context: "commit \(shown.commit.short) (\(shown.commit.subject))")
    }
  }

  private func show(_ targets: [DiffTarget], _ change: FileChange) {
    commit = nil
    guard let start = targets.first(where: { $0.change == change }) else { return }
    // a sheet on its way out and a cover on its way in do not mix
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { diff = DiffList(targets: targets, start: start.id) }
  }

  /// the comments waiting to go to the agent
  @ViewBuilder
  private func outbox(_ draft: ReviewDraft) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 1) {
        Text("\(draft.comments.count) comment\(draft.comments.count == 1 ? "" : "s")").font(.subheadline.weight(.semibold)).foregroundStyle(look.text)
        Text("on \(Set(draft.comments.map(\.path)).count) file\(Set(draft.comments.map(\.path)).count == 1 ? "" : "s")").font(.caption).foregroundStyle(look.dim)
      }
      Spacer()
      Button("Discard", role: .destructive) { draft.comments = [] }.font(.subheadline)
      Button {
        sending = true
        Task {
          do {
            let message = try Shared.main.call("reviewMessage", [json(draft.comments)])
            try await open.get(key, model).session.send(message)
            draft.comments = []
            // back to the conversation, where the answer will come
            hideKeyboard()
            path.removeAll { $0 == .review(key) }
          } catch {
            failure = Notice(title: "Not sent", text: error.localizedDescription)
          }
          sending = false
        }
      } label: {
        if sending { ProgressView() } else { Text("Send to the agent").fontWeight(.semibold) }
      }
      .buttonStyle(.borderedProminent)
      .disabled(sending)
      .accessibilityIdentifier("send-comments")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(look.panel)
  }
}

struct ChangeRow: View {
  let change: FileChange
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 10) {
      Text(change.kind == "?" ? "U" : change.kind).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(color).frame(width: 16)
      VStack(alignment: .leading, spacing: 2) {
        Text(change.name).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle).strikethrough(change.kind == "D")
        if !change.folder.isEmpty || change.oldPath != nil {
          Text(change.oldPath.map { "from \($0)" } ?? change.folder).font(.caption).foregroundStyle(look.dim).lineLimit(1).truncationMode(.head)
        }
      }
      Spacer(minLength: 4)
      if change.binary == true {
        Text("binary").font(.caption).foregroundStyle(look.faint)
      } else {
        if let added = change.added, added > 0 { Text("+\(added)").font(.caption.monospacedDigit()).foregroundStyle(Color(hex: "#3fb950")) }
        if let removed = change.removed, removed > 0 { Text("−\(removed)").font(.caption.monospacedDigit()).foregroundStyle(Color(hex: "#f85149")) }
      }
    }
  }

  private var color: Color {
    switch change.kind {
    case "A", "?": Color(hex: "#3fb950")
    case "D": Color(hex: "#f85149")
    case "U": look.waiting
    default: look.accent
    }
  }
}

/// Every file of the repository, a folder at a time.
private struct FileTree: View {
  let model: AppModel
  let store: ReviewStore
  @Environment(\.look) private var look
  @State private var at = ""
  @State private var file: String?

  var body: some View {
    let (folders, files) = children
    Section {
      if !at.isEmpty {
        Button { at = at.contains("/") ? String(at[..<at.lastIndex(of: "/")!]) : "" } label: {
          Label(at, systemImage: "chevron.left").foregroundStyle(look.accent).lineLimit(1).truncationMode(.head)
        }
        .listRowBackground(look.panel)
      }
      if store.files.isEmpty { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear) }
      ForEach(folders, id: \.self) { name in
        Button { at = at.isEmpty ? name : "\(at)/\(name)" } label: {
          Label(name, systemImage: "folder.fill").foregroundStyle(look.text)
        }
        .listRowBackground(look.panel)
      }
      ForEach(files, id: \.self) { name in
        Button { file = at.isEmpty ? name : "\(at)/\(name)" } label: {
          Label(name, systemImage: "doc.text").foregroundStyle(look.text)
        }
        .listRowBackground(look.panel)
      }
    }
    .fullScreenCover(item: Binding(get: { file.map { OneFile(path: $0) } }, set: { file = $0?.path })) { one in
      let change = FileChange(path: one.path, oldPath: nil, kind: "M", added: nil, removed: nil, binary: nil)
      DiffScreen(
        model: model, store: store, draft: ReviewDraft(),
        targets: [DiffTarget(change: change, old: .worktree(one.path), new: .worktree(one.path), anchor: "file", context: "the file as it is now")], start: "file" + change.id, whole: true
      )
      .environment(\.look, look)
    }
  }

  struct OneFile: Identifiable {
    var path: String
    var id: String { path }
  }

  /// the folders and files directly inside the folder being looked at
  private var children: ([String], [String]) {
    let prefix = at.isEmpty ? "" : at + "/"
    var folders = Set<String>()
    var files: [String] = []
    for path in store.files where path.hasPrefix(prefix) {
      let rest = path.dropFirst(prefix.count)
      if let slash = rest.firstIndex(of: "/") { folders.insert(String(rest[..<slash])) } else { files.append(String(rest)) }
    }
    return (folders.sorted { $0.localizedStandardCompare($1) == .orderedAscending }, files.sorted { $0.localizedStandardCompare($1) == .orderedAscending })
  }
}

/// One file's diff, full screen: in one column upright, side by side with the phone turned. Tap a line to comment on it.
struct DiffScreen: View {
  let model: AppModel
  let store: ReviewStore
  let draft: ReviewDraft
  let targets: [DiffTarget]
  @State var current: String
  /// the whole file as it is, not a diff (the Files tab)
  var whole = false
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @Environment(\.verticalSizeClass) private var height
  @State private var loaded: [String: Loaded] = [:]
  @State private var writing: Writing?
  @State private var scroll = false

  enum Loaded: Equatable {
    case text(old: String, new: String)
    case picture(Data)
    case note(String)
  }

  struct Writing: Identifiable {
    let id = UUID()
    var side: String
    var line: Int
    var code: String
    var text = ""
  }

  init(model: AppModel, store: ReviewStore, draft: ReviewDraft, targets: [DiffTarget], start: String, whole: Bool = false) {
    self.model = model
    self.store = store
    self.draft = draft
    self.targets = targets
    self.whole = whole
    _current = State(initialValue: start)
  }

  var body: some View {
    let index = targets.firstIndex { $0.id == current } ?? 0
    let target = targets[index]
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button("Done") { dismiss() }.fontWeight(.semibold).accessibilityIdentifier("diff-done")
        VStack(alignment: .leading, spacing: 1) {
          Text(target.change.name).font(.subheadline.weight(.semibold)).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
          Text(whole ? target.change.folder : "\(index + 1) of \(targets.count)" + (target.change.folder.isEmpty ? "" : " · \(target.change.folder)")).font(.caption2).foregroundStyle(look.dim).lineLimit(1).truncationMode(.head)
        }
        Spacer(minLength: 0)
        Button("Long lines", systemImage: scroll ? "arrow.left.and.right.text.vertical" : "text.word.spacing") { scroll.toggle() }.labelStyle(.iconOnly)
          .accessibilityLabel(scroll ? "Wrap long lines" : "Scroll long lines sideways")
        if targets.count > 1 {
          Button("Previous file", systemImage: "chevron.up") { current = targets[index - 1].id }.labelStyle(.iconOnly).disabled(index == 0)
          Button("Next file", systemImage: "chevron.down") { current = targets[index + 1].id }.labelStyle(.iconOnly).disabled(index == targets.count - 1).accessibilityIdentifier("diff-next")
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(look.panel)
      ZStack {
        look.ground
        switch loaded[target.id] {
        case .text(let old, let new):
          let dir = store.repo?.path ?? ""
          if whole {
            WebPane(model: model, host: store.host, dir: dir, content: .code(path: target.change.path, text: new))
          } else {
            WebPane(model: model, host: store.host, dir: dir, content: .diff(input(target, old, new))) { side, line, code in
              writing = Writing(side: side, line: line, code: code, text: draft.comments.first { $0.anchor == target.anchor && $0.path == target.change.path && $0.side == side && $0.end == line }?.text ?? "")
            }
          }
        case .picture(let data):
          if let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().padding(12) }
        case .note(let why): Text(why).foregroundStyle(look.dim).multilineTextAlignment(.center).padding(28)
        case nil: ProgressView()
        }
      }
    }
    .background(look.panel.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .task(id: current) { await load(target) }
    .sheet(item: $writing) { draftLine in
      CommentSheet(writing: draftLine, path: target.change.path) { text in save(target, draftLine, text) }.environment(\.look, look)
    }
  }

  /// what the page's `KunaWeb.diff` takes
  private func input(_ target: DiffTarget, _ old: String, _ new: String) -> String {
    struct Note: Encodable { var side: String; var line: Int; var text: String }
    struct Input: Encodable { var path: String; var old: String; var new: String; var split: Bool; var scroll: Bool; var notes: [Note] }
    let notes = draft.comments.filter { $0.anchor == target.anchor && $0.path == target.change.path }.map { Note(side: $0.side, line: $0.end, text: $0.text) }
    return json(Input(path: target.change.path, old: old, new: new, split: height == .compact, scroll: scroll, notes: notes))
  }

  private func save(_ target: DiffTarget, _ line: Writing, _ text: String) {
    draft.comments.removeAll { $0.anchor == target.anchor && $0.path == target.change.path && $0.side == line.side && $0.end == line.line }
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft.comments.append(
      ReviewComment(path: target.change.path, side: line.side, start: line.line, end: line.line, text: text, code: [line.code], anchor: target.anchor, context: target.context))
  }

  private func load(_ target: DiffTarget) async {
    guard loaded[target.id] == nil else { return }
    let isPicture = ["png", "jpg", "jpeg", "gif", "webp"].contains(target.change.path.split(separator: ".").last?.lowercased() ?? "")
    do {
      let sides = try await store.read(whole ? [target.new] : [target.old, target.new])
      var blobs: [Data] = []
      for side in sides {
        switch side {
        case .failure(let why):
          loaded[target.id] = .note(why.message)
          return
        case .success(let data): blobs.append(data ?? Data())
        }
      }
      if isPicture {
        // the picture as it is now; one that was removed, as it was
        loaded[target.id] = (blobs.last { !$0.isEmpty }).map { .picture($0) } ?? .note("There is no picture on either side.")
      } else if blobs.contains(where: { $0.prefix(8000).contains(0) }) {
        loaded[target.id] = .note("This is a binary file.")
      } else {
        let texts = blobs.map { String(decoding: $0, as: UTF8.self) }
        loaded[target.id] = .text(old: whole ? "" : texts.first ?? "", new: texts.last ?? "")
      }
    } catch {
      loaded[target.id] = .note(error.localizedDescription)
    }
  }
}

private struct CommentSheet: View {
  let writing: DiffScreen.Writing
  let path: String
  let save: (String) -> Void
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            Text(writing.code.isEmpty ? " " : writing.code).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(look.dim).lineLimit(3)
          } header: {
            Text("\(path):\(writing.line)" + (writing.side == "old" ? " (as it was)" : ""))
          }
          Section {
            TextField("What should change here?", text: $text, axis: .vertical).lineLimit(3...10).focused($focused).accessibilityIdentifier("comment-text")
          } footer: {
            Text("Comments are sent to the agent together, from the review's first screen. Empty removes this one.")
          }
        }
        .listRowBackground(look.panel)
      }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .navigationTitle("Comment")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            save(text)
            hideKeyboard()
            dismiss()
          }
          .accessibilityIdentifier("comment-save")
        }
      }
      .onAppear {
        text = writing.text
        focused = true
      }
    }
    .presentationDetents([.medium, .large])
    .preferredColorScheme(.dark)
  }
}
#endif
