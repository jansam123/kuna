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
    .refreshable { await load() }
    .task { if listing == nil { await load() } }
    .fullScreenCover(item: $showing) { item in
      ViewerScreen(model: model, store: store, host: host, items: listing?.files ?? [item], start: item).environment(\.look, look)
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
