#if os(iOS)
import KunaCore
import SwiftUI

/// What is in a folder on a host (`folder` in ios/bridge.ts): its folders, and its files as the
/// viewer takes them (`kind` `file`: not a picture, PDF, Markdown file or page).
struct FolderListing: Decodable {
  var more: Int?
  var folders: [String]
  var files: [MediaItem]
}

/// The Folders tab: folders kept to look through, by host. A path typed here, or a folder kept
/// with its star while looking through another; the projects' own folders are there already.
struct PlacesView: View {
  let model: AppModel
  @Binding var path: [Route]
  @Environment(\.look) private var look
  /// the host a path is being typed for
  @State private var adding: String?
  @State private var typed = "~/"

  var body: some View {
    List {
      if model.state.hosts.isEmpty { Text("No hosts yet. Add one under Settings.").foregroundStyle(look.dim).listRowBackground(look.panel) }
      ForEach(model.state.hosts) { host in
        let kept = model.state.places?[host.alias] ?? []
        let projects = model.state.projects.filter { $0.host == host.alias }.flatMap { project in project.folders.map { (project, $0) } }.filter { !kept.contains($0.1.path) }
        Section {
          ForEach(kept, id: \.self) { place in row(host.alias, place, nil) }
            .onDelete { gone in for i in gone { model.keepPlace(host.alias, kept[i], false) } }
          ForEach(projects, id: \.1.id) { project, folder in row(host.alias, folder.path, "\(model.plain(project.name)) · \(model.plain(folder.name))") }
          Button("Add a folder", systemImage: "plus") {
            typed = "~/"
            adding = host.alias
          }
          .listRowBackground(look.panel)
          .accessibilityIdentifier("add-place-\(host.alias)")
        } header: {
          Text(host.alias)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(look.ground)
    .navigationTitle("Folders")
    .navigationBarTitleDisplayMode(.inline)
    .alert("A folder on \(adding ?? "")", isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } })) {
      TextField("~/path/on/the/host", text: $typed).plain()
      Button("Save") {
        var place = typed.trimmingCharacters(in: .whitespaces)
        while place.count > 1, place.hasSuffix("/") { place.removeLast() }
        if let adding, place.hasPrefix("/") || place == "~" || place.hasPrefix("~/") { model.keepPlace(adding, place) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Its path on the host, starting with / or ~/.")
    }
  }

  private func row(_ host: String, _ place: String, _ from: String?) -> some View {
    Button { path.append(.files(host, place)) } label: {
      HStack(spacing: 10) {
        Image(systemName: from == nil ? "star.fill" : "folder.fill").foregroundStyle(from == nil ? look.waiting : look.accent).frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(place).font(.subheadline.monospaced()).foregroundStyle(look.text).lineLimit(1).truncationMode(.head)
          if let from { Text(from).font(.caption).foregroundStyle(look.dim).lineLimit(1) }
        }
        Spacer(minLength: 4)
        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(look.faint)
      }
    }
    .listRowBackground(look.panel)
    .accessibilityIdentifier("place-\(place)")
  }
}

/// A folder on a host, git or not, to look through and to take files from: the Mac's ⇧⌘E.
/// Read one folder at a time, as it is opened.
struct FolderScreen: View {
  let model: AppModel
  let host: String
  let dir: String
  @Binding var path: [Route]
  @Environment(\.look) private var look
  @State private var listing: FolderListing?
  @State private var problem: String?
  @State private var store = MediaStore()
  @State private var showing: MediaItem?
  /// the file being fetched for a download, and where its copy on the phone is
  @State private var fetching: String?
  @State private var saving: URL?

  /// `~` as the host's home: pages and pictures are asked for by their full path
  private var full: String {
    guard dir.hasPrefix("~"), let home = model.links[host]?.home, !home.isEmpty else { return dir }
    return home + dir.dropFirst()
  }

  var body: some View {
    List {
      if let problem { Text(problem).foregroundStyle(look.danger).listRowBackground(look.panel) }
      if let listing {
        if let more = listing.more { Text("\(more) entries: the first 3000 are shown.").font(.footnote).foregroundStyle(look.dim).listRowBackground(look.panel) }
        if listing.folders.isEmpty, listing.files.isEmpty { Text("This folder is empty.").foregroundStyle(look.dim).listRowBackground(look.panel) }
        ForEach(listing.folders, id: \.self) { name in
          Button { path.append(.files(host, full == "/" ? "/\(name)" : "\(full)/\(name)")) } label: {
            HStack(spacing: 10) {
              Image(systemName: "folder.fill").foregroundStyle(look.accent).frame(width: 24)
              Text(name).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
              Spacer(minLength: 4)
              Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(look.faint)
            }
          }
          .listRowBackground(look.panel)
          .accessibilityIdentifier("dir-\(name)")
        }
        ForEach(listing.files) { item in
          Button { showing = item } label: {
            HStack(spacing: 10) {
              Image(systemName: symbol(item.kind)).foregroundStyle(look.dim).frame(width: 24)
              Text(item.name).foregroundStyle(look.text).lineLimit(1).truncationMode(.middle)
              Spacer(minLength: 4)
              if fetching == item.path {
                ProgressView().controlSize(.small)
              } else {
                VStack(alignment: .trailing, spacing: 2) {
                  Text(sizeText(item.size)).font(.caption.monospacedDigit()).foregroundStyle(look.dim)
                  Text(ago(item.mtime)).font(.caption2.monospacedDigit()).foregroundStyle(look.faint)
                }
              }
            }
          }
          .listRowBackground(look.panel)
          .accessibilityIdentifier("file-\(item.name)")
          .swipeActions(edge: .trailing) { Button("Download", systemImage: "arrow.down.to.line") { download(item) }.tint(look.accent) }
          .contextMenu { Button("Download", systemImage: "arrow.down.to.line") { download(item) } }
        }
      } else if problem == nil {
        HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
      }
    }
    .scrollContentBackground(.hidden)
    .background(look.ground)
    .navigationTitle(full.split(separator: "/").last.map(String.init) ?? "/")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      let kept = model.state.places?[host]?.contains(dir) == true
      Button(kept ? "Take it off the Folders tab" : "Keep it on the Folders tab", systemImage: kept ? "star.fill" : "star") { model.keepPlace(host, dir, !kept) }
        .accessibilityIdentifier("keep-place")
    }
    .refreshable { await load() }
    .task { if listing == nil { await load() } }
    .inPlace($showing) { item in
      ViewerScreen(model: model, store: store, host: host, items: listing?.files ?? [item], start: item) {
        showing = nil
        // what was edited has another size and time now
        if store.edited { Task { await load() } }
      }
    }
    .fileMover(isPresented: Binding(get: { saving != nil }, set: { if !$0 { saving = nil } }), file: saving) { _ in saving = nil }
  }

  private func symbol(_ kind: String) -> String {
    switch kind {
    case "image", "svg": "photo"
    case "pdf": "doc.richtext"
    case "md": "doc.text"
    case "html": "chevron.left.forwardslash.chevron.right"
    default: "doc"
    }
  }

  private func load() async {
    problem = nil
    Connection.start()
    do {
      let out = try await model.done(host, ["lsdir", Data(full.utf8).base64EncodedString()], timeout: 40, or: "Could not read the folder.")
      listing = try Shared.main.decode(FolderListing.self, "folder", [out.text, full])
    } catch {
      problem = error.localizedDescription
    }
  }

  /// Fetch the file whole, then ask where on the phone it goes.
  private func download(_ item: MediaItem) {
    fetching = item.path
    Task {
      do { saving = try phoneCopy(of: try await store.data(for: item, host: host, model: model), named: item.name) } catch { problem = error.localizedDescription }
      fetching = nil
    }
  }
}

/// A copy of a host's file on the phone, under its own name, for the Files picker to move where the user says.
func phoneCopy(of data: Data, named name: String) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "kuna-save/\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let file = dir.appending(path: name)
  try data.write(to: file)
  return file
}
#endif
