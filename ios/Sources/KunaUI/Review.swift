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

/// One line of a branch picker (`RefOption` in src/shared/git.ts).
struct RefOption: Decodable, Hashable, Identifiable {
  /// none: the working tree
  var value: String?
  var label: String
  var detail: String?
  /// worktree, branch, remote, tag, commit
  var kind: String
  var time: Double?
  var id: String { "\(kind):\(value ?? "")" }
}

struct GitOverview: Decodable, Hashable {
  var info: GitInfo
  /// what the review starts on: origin's default branch, and what is checked out
  var base: String?
  var head: String?
  var bases: [RefOption]
  var heads: [RefOption]
  var conflicts: [FileChange]
  var staged: [FileChange]
  var unstaged: [FileChange]
  var untracked: [FileChange]
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
  /// the commit the files are listed at; none: what is on disk
  private(set) var filesRev: String?
  @ObservationIgnored private var filesKey: String?
  /// what the changes are compared with
  private(set) var base = ""
  /// whose changes: a branch or a commit; none: the working tree, uncommitted changes included
  private(set) var head: String?
  /// a head picked stays; what is checked out follows the repository
  @ObservationIgnored private var headPicked = false
  private(set) var loading = false
  private(set) var problem: String?
  /// why there is no comparison
  private(set) var compareProblem: String?

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

  /// the base picked for a repository, kept on the phone as the Mac keeps its own
  private var saved: [String: String] {
    get { UserDefaults.standard.dictionary(forKey: "reviewBase") as? [String: String] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: "reviewBase") }
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
      if base.isEmpty {
        let kept = saved["\(host):\(seen.info.root)"]
        base = kept.flatMap { name in seen.info.refs.contains { $0.short == name } ? name : nil } ?? seen.base ?? ""
      }
      if !headPicked { head = seen.head }
      await loadCompare()
    } catch {
      problem = error.localizedDescription
    }
  }

  /// Another repository of the agent's folder: its own base and head.
  func open(_ repo: GitRepo) async {
    self.repo = repo
    base = ""
    headPicked = false
    overview = nil
    await load()
  }

  func pick(base name: String) async {
    base = name
    if let root = overview?.info.root { saved["\(host):\(root)"] = name }
    await loadCompare()
  }

  func pick(head name: String?) async {
    head = name
    headPicked = true
    await loadCompare()
  }

  /// Head against the base, as a pull request shows it (`base...head`): its files and its commits.
  func loadCompare() async {
    guard let repo, let overview else { return }
    compare = nil
    commits = []
    latest = false
    compareProblem = nil
    guard overview.info.head != nil else { return compareProblem = "No commits yet: what there is shows under Uncommitted." }
    guard !base.isEmpty else { return }
    do {
      let seen = try Shared.main.decode(GitCompare.self, "gitCompare", [try await git(["compare", b64(repo.path), b64(base), head.map(b64) ?? ""]).text, base, head ?? ""])
      compare = seen
      commits = seen.commits
    } catch {
      compareProblem = error.localizedDescription
      // a head that is gone (a branch deleted, a name typed wrong): back to what is checked out
      if let gone = head, headPicked, error.localizedDescription.contains("unknown branch or commit: \(gone)") {
        head = overview.head
        headPicked = false
        return await loadCompare()
      }
    }
    if commits.isEmpty, compare != nil {
      // on the base branch itself: the branch's own latest commits
      for back in [20, 5, 1] {
        guard let out = try? await git(["compare", b64(repo.path), b64("HEAD~\(back)"), b64("HEAD")]) else { continue }
        commits = (try? Shared.main.decode(GitCompare.self, "gitCompare", [out.text, "HEAD~\(back)", "HEAD"]).commits) ?? []
        latest = true
        break
      }
    }
    if filesKey != nil { await loadFiles() }
  }

  /// Every file: what is on disk when head is checked out here, else the files at head.
  func loadFiles() async {
    guard let repo else { return }
    let rev = head == nil || head == overview?.info.branch ? nil : compare?.tip
    let key = "\(repo.path)\n\(rev ?? "")"
    guard filesKey != key || files.isEmpty else { return }
    filesKey = key
    filesRev = rev
    files = []
    if let out = try? await git(["files", b64(repo.path), rev.map(b64) ?? ""]) { files = (try? Shared.main.decode([String].self, "gitFiles", [out.text])) ?? [] }
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
  /// the branch list that is open: `base` or `head`
  @State private var picking: Picking?
  @State private var diff: DiffList?
  @State private var commit: CommitFiles?
  @State private var sending = false
  @State private var failure: Notice?

  enum Picking: String, Identifiable {
    case base, head
    var id: String { rawValue }
  }

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
    .toolbar {
      if let store {
        // the agent's folder itself, git or not (the Mac's Folder list)
        Button("Folder", systemImage: "folder") { path.append(.files(store.host, store.dir)) }.accessibilityIdentifier("review-folder")
      }
    }
    .sheet(item: $picking) { which in
      if let store, let overview = store.overview {
        RefSheet(
          title: which == .base ? "Compare with (base)" : "Changes in (head)", options: which == .base ? overview.bases : overview.heads,
          current: which == .base ? store.base : store.head
        ) { picked in
          tab = "changes"
          Task { if which == .base, let picked { await store.pick(base: picked) } else if which == .head { await store.pick(head: picked) } }
        }
        .environment(\.look, look)
      }
    }
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
          if let repo = store.repos.first(where: { $0.path == picked }) { Task { await store.open(repo) } }
        })) {
          ForEach(store.repos) { Text($0.label).tag($0.path) }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
      }
      if store.overview != nil { refs(store) }
      Picker("What to look at", selection: $tab) {
        Text("Changes").tag("changes")
        Text("Uncommitted").tag("local")
        Text("Files").tag("files")
        Text("Commits").tag("commits")
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      List {
        if let problem = store.problem { Text(problem).foregroundStyle(look.danger).listRowBackground(look.panel) }
        if store.loading, store.overview == nil { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear) }
        if !store.loading, store.repos.isEmpty, store.problem == nil {
          Text("There is no git repository in this agent's folder, or within three folders below it. The folder button above shows its files.").foregroundStyle(look.dim).listRowBackground(look.panel)
        }
        if let overview = store.overview {
          switch tab {
          case "changes": changes(store, overview)
          case "local": local(store, overview)
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

  /// base ← head, as on the Mac: each opens its list of branches
  private func refs(_ store: ReviewStore) -> some View {
    func chip(_ name: String, _ which: Picking) -> some View {
      Button { picking = which } label: {
        HStack(spacing: 5) {
          Image(systemName: which == .head && store.head == nil ? "internaldrive" : "arrow.triangle.branch").font(.caption2)
          Text(name).font(.footnote.monospaced()).lineLimit(1).truncationMode(.middle)
          Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(look.faint)
        }
        .foregroundStyle(look.text).padding(.horizontal, 10).padding(.vertical, 7)
        .background(look.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("ref-\(which.rawValue)")
      .accessibilityLabel(which == .base ? "Compare with \(name)" : "The changes of \(name)")
    }
    return HStack(spacing: 8) {
      chip(store.base.isEmpty ? "Choose…" : store.base, .base)
      Image(systemName: "arrow.left").font(.caption.weight(.bold)).foregroundStyle(look.dim)
      chip(store.head ?? "Working tree", .head)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.top, 8)
  }

  /// head against the base as a pull request shows it: everything since the branch left the base
  @ViewBuilder
  private func changes(_ store: ReviewStore, _ overview: GitOverview) -> some View {
    if let why = store.compareProblem { Text(why).foregroundStyle(look.dim).listRowBackground(look.panel) }
    if let compare = store.compare {
      let branch = overview.info.branch ?? "HEAD"
      let targets = compare.files.map { change in
        DiffTarget(
          change: change, old: change.kind == "A" || change.kind == "?" ? .empty : .rev(compare.mergeBase, change.oldPath ?? change.path),
          new: change.kind == "D" ? .empty : compare.head == nil ? .worktree(change.path) : .rev(compare.tip, change.path),
          anchor: "cmp:\(compare.base)...\(compare.head ?? "")",
          context: compare.head.map { "`\($0)` compared with `\(compare.base)`" } ?? "the working tree of `\(branch)` (uncommitted changes included), compared with `\(compare.base)`")
      }
      Section {
        if targets.isEmpty {
          Text(compare.head == store.base ? "\(store.base) is compared with itself. Pick another branch above." : "No differences.").foregroundStyle(look.dim).listRowBackground(look.panel)
        }
        ForEach(targets) { target in
          Button { show(targets, target.change) } label: { ChangeRow(change: target.change) }.listRowBackground(look.panel).accessibilityIdentifier("change-\(target.change.name)")
        }
      } header: {
        HStack(spacing: 6) {
          Text("\(targets.count) file\(targets.count == 1 ? "" : "s")")
          Text("+\(compare.files.reduce(0) { $0 + ($1.added ?? 0) })").foregroundStyle(Color(hex: "#3fb950"))
          Text("−\(compare.files.reduce(0) { $0 + ($1.removed ?? 0) })").foregroundStyle(Color(hex: "#f85149"))
        }
        .font(.footnote.monospacedDigit())
      } footer: {
        Text(compare.head == nil ? "What is on disk, uncommitted changes and new files included, since it left \(compare.base)." : "What \(compare.head ?? "") changed since it left \(compare.base).")
      }
    } else if store.compareProblem == nil, store.problem == nil {
      HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
    }
  }

  /// what is not committed, in VS Code's groups: conflicts, staged (HEAD → index), changes (index → disk), untracked
  @ViewBuilder
  private func local(_ store: ReviewStore, _ overview: GitOverview) -> some View {
    // HEAD by its commit, none before the first
    let atHead = { (path: String) -> GitSide in overview.info.head.map { .rev($0, path) } ?? .empty }
    let groups: [(String, [DiffTarget])] = [
      ("Merge conflicts", overview.conflicts.map { DiffTarget(change: $0, old: atHead($0.path), new: .worktree($0.path), anchor: "l:u", context: "the files in conflict") }),
      ("Staged changes", overview.staged.map {
        DiffTarget(change: $0, old: $0.kind == "A" ? .empty : atHead($0.oldPath ?? $0.path), new: $0.kind == "D" ? .empty : .index($0.path), anchor: "l:s", context: "the staged changes")
      }),
      ("Changes", overview.unstaged.map {
        DiffTarget(change: $0, old: .index($0.path), new: $0.kind == "D" ? .empty : .worktree($0.path), anchor: "l:w", context: "the unstaged changes (not committed yet)")
      }),
      ("Untracked", overview.untracked.map { DiffTarget(change: $0, old: .empty, new: .worktree($0.path), anchor: "l:n", context: "the new, untracked files") })
    ].filter { !$0.1.isEmpty }
    if groups.isEmpty {
      Text("Nothing is changed since the last commit" + (overview.info.branch.map { " on \($0)." } ?? ".")).foregroundStyle(look.dim).listRowBackground(look.panel)
    }
    ForEach(groups, id: \.0) { label, targets in
      Section("\(label) · \(targets.count)") {
        ForEach(targets) { target in
          Button { show(targets, target.change) } label: { ChangeRow(change: target.change) }.listRowBackground(look.panel).accessibilityIdentifier("change-\(target.change.name)")
        }
      }
    }
  }

  @ViewBuilder
  private func commits(_ store: ReviewStore) -> some View {
    Section(store.latest ? "Latest commits" : "Commits of \(store.head ?? "the working tree") since \(store.base)") {
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
        anchor: "cmp:\(shown.commit.sha)^...\(shown.commit.sha)", context: "commit \(shown.commit.short) (\"\(shown.commit.subject)\")")
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

/// A list of branches to pick from, as the Mac's: local branches first (newest first), then remote
/// ones and tags; type to narrow it, or a commit or name that is not in the list.
private struct RefSheet: View {
  let title: String
  let options: [RefOption]
  let current: String?
  let pick: (String?) -> Void
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  private var shown: [RefOption] {
    let words = query.lowercased().split(separator: " ")
    var hits = options.filter { option in words.allSatisfy { "\(option.label) \(option.detail ?? "")".lowercased().contains($0) } }
    let name = query.trimmingCharacters(in: .whitespaces)
    if !name.isEmpty, !options.contains(where: { $0.value == name }), (try? Shared.main.call("gitValidRef", [name])) == "true" {
      hits.append(RefOption(value: name, label: name, detail: "a branch, tag or commit by name", kind: "commit", time: nil))
    }
    return hits
  }

  var body: some View {
    NavigationStack {
      List(shown) { option in
        Button {
          pick(option.value)
          dismiss()
        } label: {
          HStack(spacing: 10) {
            Image(systemName: mark(option.kind)).font(.footnote).foregroundStyle(option.kind == "branch" ? look.accent : look.dim).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
              Text(option.label).font(.subheadline.monospaced()).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
              if let detail = option.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(look.dim).lineLimit(1) }
            }
            Spacer(minLength: 4)
            if let time = option.time, time > 0 { Text(ago(time)).font(.caption.monospacedDigit()).foregroundStyle(look.faint) }
            if option.value == current { Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(look.accent) }
          }
        }
        .listRowBackground(look.panel)
        .accessibilityIdentifier("ref-\(option.label)")
      }
      .overlay { if shown.isEmpty { Text("Nothing matches.").foregroundStyle(look.dim) } }
      .scrollContentBackground(.hidden)
      .background(look.ground)
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter branches, or type a commit")
      .plain()
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .preferredColorScheme(.dark)
  }

  private func mark(_ kind: String) -> String {
    switch kind {
    case "worktree": "internaldrive"
    case "remote": "cloud"
    case "tag": "tag"
    case "commit": "smallcircle.filled.circle"
    default: "arrow.triangle.branch"
    }
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
      // as it is on disk, or at head when head is not what is checked out here
      let side: GitSide = store.filesRev.map { .rev($0, one.path) } ?? .worktree(one.path)
      DiffScreen(
        model: model, store: store, draft: ReviewDraft(),
        targets: [DiffTarget(change: change, old: side, new: side, anchor: "file", context: "the file as it is now")], start: "file" + change.id, whole: true
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
