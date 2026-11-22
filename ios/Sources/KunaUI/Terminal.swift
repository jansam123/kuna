#if os(iOS)
import KunaCore
import SwiftTerm
import SwiftUI
import UIKit

/// The emulator that reads an agent's screen as text, shown or not: the terminal view keeps its
/// own emulator to itself, and the app has to know what the screen says before typing into it.
private final class ScreenReader: TerminalDelegate {
  var answer: ((Data) -> Void)?
  func send(source: Terminal, data: ArraySlice<UInt8>) { answer?(Data(data)) }
}

/// An agent's terminal for as long as the agent's screen is open: fed even while it is not
/// shown, so the app can tell what the agent's own screen says.
@MainActor
final class TerminalHolder: NSObject, TerminalViewDelegate {
  private(set) var view: TerminalView?
  private let session: AgentSession
  private let reader = ScreenReader()
  private let screen: Terminal

  init(session: AgentSession) {
    self.session = session
    var options = TerminalOptions.default
    options.cols = session.size.cols
    options.rows = session.size.rows
    screen = Terminal(delegate: reader, options: options)
    super.init()
    // until a view is shown, the reader answers what the host asks of the terminal (its size, its kind)
    reader.answer = { [weak self] data in
      Task { @MainActor in if self?.view == nil { self?.session.write(data) } }
    }
    session.onOutput = { [weak self] data in
      self?.screen.feed(buffer: ArraySlice(data))
      self?.view?.feed(byteArray: ArraySlice(data))
    }
    session.screen = { [weak self] in
      guard let screen = self?.screen else { return [] }
      return (0..<screen.rows).map { row in
        screen.getText(start: Position(col: 0, row: row), end: Position(col: screen.cols, row: row)).trimmingCharacters(in: CharacterSet(charactersIn: "\n\r"))
      }
    }
  }

  /// The view, made when the terminal is first shown.
  func view(theme: Theme, fontSize: CGFloat) -> TerminalView {
    if let view {
      apply(theme, fontSize, to: view)
      return view
    }
    let view = TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
    view.terminalDelegate = self
    view.inputAccessoryView = nil
    view.optionAsMetaKey = true
    apply(theme, fontSize, to: view)
    let drawn = session.drawnSoFar
    if !drawn.isEmpty { view.feed(byteArray: ArraySlice(drawn)) }
    self.view = view
    return view
  }

  private func apply(_ theme: Theme, _ size: CGFloat, to view: TerminalView) {
    let t = theme.terminal
    view.nativeBackgroundColor = UIColor(hex: t["background"] ?? "#000000")
    view.nativeForegroundColor = UIColor(hex: t["foreground"] ?? "#dfe6f5")
    view.caretColor = UIColor(hex: t["cursor"] ?? theme.accent)
    view.selectedTextBackgroundColor = UIColor(hex: t["selectionBackground"] ?? "#4d8dff55")
    let names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]
    let colors = names.compactMap { t[$0] }.map(Self.color)
    if colors.count == 16 { view.installColors(colors) }
    if view.font.pointSize != size { view.font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular) }
  }

  private static func color(_ hex: String) -> SwiftTerm.Color {
    var v: UInt64 = 0
    Scanner(string: String(hex.dropFirst())).scanHexInt64(&v)
    // 16 bits a channel
    return SwiftTerm.Color(red: UInt16((v >> 16) & 0xff) * 257, green: UInt16((v >> 8) & 0xff) * 257, blue: UInt16(v & 0xff) * 257)
  }

  // what the terminal view asks of its owner
  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    guard newCols > 1, newRows > 1 else { return }
    screen.resize(cols: newCols, rows: newRows)
    session.resize(cols: newCols, rows: newRows)
  }
  func send(source: TerminalView, data: ArraySlice<UInt8>) { session.write(Data(data)) }
  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    if let url = URL(string: link), url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
  }
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) { UIPasteboard.general.string = String(decoding: content, as: UTF8.self) }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

private struct TerminalPane: UIViewRepresentable {
  let view: TerminalView
  func makeUIView(context: Context) -> TerminalView { view }
  func updateUIView(_ view: TerminalView, context: Context) {}
}

/// The agent's own screen, full size, with the keys a phone keyboard lacks.
struct TerminalScreen: View {
  let model: AppModel
  let session: AgentSession
  let holder: TerminalHolder
  let title: String
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss
  @AppStorage("termFont") private var fontSize = 11.0
  @State private var problem: String?
  @State private var ctrl = false

  var body: some View {
    let view = holder.view(theme: model.theme, fontSize: fontSize)
    VStack(spacing: 0) {
      HStack(spacing: 14) {
        Button("Done") { dismiss() }.fontWeight(.semibold).accessibilityIdentifier("terminal-done")
        Text(title).font(.subheadline).foregroundStyle(look.dim).lineLimit(1)
        Spacer(minLength: 0)
        Button("Smaller text", systemImage: "textformat.size.smaller") { fontSize = max(8, fontSize - 1) }.labelStyle(.iconOnly)
        Button("Larger text", systemImage: "textformat.size.larger") { fontSize = min(18, fontSize + 1) }.labelStyle(.iconOnly)
        Button("Keyboard", systemImage: "keyboard") {
          if view.isFirstResponder { _ = view.resignFirstResponder() } else { _ = view.becomeFirstResponder() }
        }
        .labelStyle(.iconOnly)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(look.panel)
      ZStack {
        Color.black
        TerminalPane(view: view).padding(.horizontal, 2)
        if session.attaching { ProgressView("Opening its screen…").tint(.white).foregroundStyle(.white) }
        if let problem {
          VStack(spacing: 12) {
            Text(problem).foregroundStyle(.white).multilineTextAlignment(.center)
            Button("Try again", action: attach).buttonStyle(.borderedProminent)
          }
          .padding(24)
        } else if session.terminalEnded, !session.attaching {
          VStack(spacing: 12) {
            Text("Its screen closed.").foregroundStyle(.white)
            Button("Open it again", action: attach).buttonStyle(.borderedProminent)
          }
          .padding(20)
          .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 14))
        }
      }
      KeyRow(ctrl: $ctrl) { session.write($0) }
    }
    .background(look.panel.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .task { attach() }
  }

  private func attach() {
    problem = nil
    Task {
      do { try await session.attach() } catch { problem = error.localizedDescription }
    }
  }
}

/// Esc, Tab, the arrows, Ctrl+C and friends: what Claude Code is steered with.
private struct KeyRow: View {
  @Binding var ctrl: Bool
  let send: (String) -> Void
  @Environment(\.look) private var look

  private static let keys: [(String, String, String)] = [
    ("esc", "\u{1b}", "Escape"), ("tab", "\t", "Tab"), ("⇧tab", "\u{1b}[Z", "Shift Tab"), ("↑", "\u{1b}[A", "Up"), ("↓", "\u{1b}[B", "Down"), ("←", "\u{1b}[D", "Left"),
    ("→", "\u{1b}[C", "Right"), ("⏎", "\r", "Enter"), ("^C", "\u{03}", "Control C"), ("^D", "\u{04}", "Control D"), ("^R", "\u{12}", "Control R"), ("^O", "\u{0f}", "Control O"),
    ("1", "1", "1"), ("2", "2", "2"), ("3", "3", "3"), ("/", "/", "Slash"),
  ]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 7) {
        ForEach(Self.keys, id: \.0) { key in
          Button { send(key.1) } label: {
            Text(key.0).font(.system(size: 15, weight: .medium, design: .monospaced)).frame(minWidth: 34, minHeight: 34).padding(.horizontal, 6)
              .background(look.raised, in: RoundedRectangle(cornerRadius: 8))
              .foregroundStyle(look.text)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(key.2)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
    }
    .background(look.panel)
  }
}
#endif
