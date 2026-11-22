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

/// The key row's Ctrl and ⌘: armed by a tap, they go with the next key.
@MainActor @Observable
final class KeyModifiers {
  var ctrl = false
  var cmd = false
}

/// An agent's terminal for as long as the agent's screen is open: fed even while it is not
/// shown, so the app can tell what the agent's own screen says.
@MainActor
final class TerminalHolder: NSObject, TerminalViewDelegate, UIGestureRecognizerDelegate {
  private(set) var view: TerminalView?
  let mods = KeyModifiers()
  /// what the view sends right now is the wheel, not a key
  private var wheeling = false
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
    // where the screen's program has the mouse (tmux), a drag is its wheel, not a press dragged across its text
    view.allowMouseReporting = false
    let pan = UIPanGestureRecognizer(target: self, action: #selector(scroll(_:)))
    pan.delegate = self
    view.addGestureRecognizer(pan)
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

  func gestureRecognizer(_ one: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

  /// A drag up or down as the mouse wheel: tmux scrolls back through what the agent wrote.
  /// A screen whose program has no mouse scrolls by itself, as any list.
  @objc private func scroll(_ pan: UIPanGestureRecognizer) {
    guard let view, pan.state == .changed else { return }
    let terminal = view.getTerminal()
    guard terminal.mouseMode != .off, terminal.rows > 0, terminal.cols > 0 else { return }
    // tmux moves five lines a notch: a notch every three lines of drag keeps up with the finger and a little more
    let notch = view.bounds.height / CGFloat(terminal.rows) * 3
    let moved = pan.translation(in: view).y
    let notches = Int(moved / notch)
    guard notches != 0 else { return }
    pan.setTranslation(CGPoint(x: 0, y: moved - CGFloat(notches) * notch), in: view)
    let at = pan.location(in: view)
    let col = min(terminal.cols - 1, max(0, Int(at.x / view.bounds.width * CGFloat(terminal.cols))))
    let row = min(terminal.rows - 1, max(0, Int((at.y - view.contentOffset.y) / view.bounds.height * CGFloat(terminal.rows))))
    // a finger going down shows what is above: wheel up
    let flags = terminal.encodeButton(button: notches > 0 ? 4 : 5, release: false, shift: false, meta: false, control: false)
    wheeling = true
    for _ in 0..<abs(notches) { terminal.sendEvent(buttonFlags: flags, x: col, y: row) }
    wheeling = false
    if notches > 0 { session.scrolledBack = true }
  }

  /// A key from the keyboard or the key row, with the row's Ctrl or ⌘ when one is armed.
  func key(_ typed: Data) {
    var data = typed
    if mods.ctrl {
      mods.ctrl = false
      // Ctrl with a letter or one of ?@[\]^_ is that key's control character
      if data.count == 1, let byte = data.first, (0x3f...0x7e).contains(byte) { data = Data([byte == 0x3f ? 0x7f : byte & 0x1f]) }
    } else if mods.cmd {
      mods.cmd = false
      switch String(decoding: data, as: UTF8.self) {
      // ⌘← ⌘→: the start and the end of the line, as on the Mac; ⌘⌫ empties it; ⌘V pastes
      case "\u{1b}[D", "\u{1b}OD": data = Data([0x01])
      case "\u{1b}[C", "\u{1b}OC": data = Data([0x05])
      case "\u{7f}": data = Data([0x15])
      case "v", "V": data = Data((UIPasteboard.general.string ?? "").utf8)
      default: break
      }
    }
    session.key(data)
  }

  // what the terminal view asks of its owner
  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    guard newCols > 1, newRows > 1 else { return }
    screen.resize(cols: newCols, rows: newRows)
    session.resize(cols: newCols, rows: newRows)
  }
  func send(source: TerminalView, data: ArraySlice<UInt8>) { if wheeling { session.write(Data(data)) } else { key(Data(data)) } }
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

/// The agent's own screen in place of its conversation, with the keys a phone keyboard lacks.
struct TerminalScreen: View {
  let model: AppModel
  let session: AgentSession
  let holder: TerminalHolder
  @AppStorage("termFont") private var fontSize = 11.0
  @State private var problem: String?

  var body: some View {
    let view = holder.view(theme: model.theme, fontSize: fontSize)
    VStack(spacing: 0) {
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
      KeyRow(mods: holder.mods, fontSize: $fontSize) {
        if view.isFirstResponder { _ = view.resignFirstResponder() } else { _ = view.becomeFirstResponder() }
      } send: {
        holder.key(Data($0.utf8))
      }
    }
    .accessibilityIdentifier("terminal")
    .task { attach() }
  }

  private func attach() {
    problem = nil
    Task {
      do { try await session.attach() } catch { problem = error.localizedDescription }
    }
  }
}

/// The keyboard's button, Ctrl and ⌘ for the next key, then Esc, Tab, the arrows, Ctrl+C and
/// friends: what Claude Code is steered with. The text's size is at the row's end.
private struct KeyRow: View {
  @Bindable var mods: KeyModifiers
  @Binding var fontSize: Double
  let keyboard: () -> Void
  let send: (String) -> Void
  @Environment(\.look) private var look

  private static let keys: [(String, String, String)] = [
    ("esc", "\u{1b}", "Escape"), ("tab", "\t", "Tab"), ("⇧tab", "\u{1b}[Z", "Shift Tab"), ("↑", "\u{1b}[A", "Up"), ("↓", "\u{1b}[B", "Down"), ("←", "\u{1b}[D", "Left"),
    ("→", "\u{1b}[C", "Right"), ("⏎", "\r", "Enter"), ("^C", "\u{03}", "Control C"), ("^D", "\u{04}", "Control D"), ("^R", "\u{12}", "Control R"),
    ("^O", "\u{0f}", "Control O"), ("1", "1", "1"), ("2", "2", "2"), ("3", "3", "3"), ("/", "/", "Slash"),
  ]

  var body: some View {
    HStack(spacing: 0) {
      cap(Image(systemName: "keyboard"), "Keyboard", action: keyboard).padding(.leading, 10)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 7) {
          cap(Text("ctrl"), "Control", on: mods.ctrl) {
            mods.ctrl.toggle()
            mods.cmd = false
          }
          cap(Text("⌘"), "Command", on: mods.cmd) {
            mods.cmd.toggle()
            mods.ctrl = false
          }
          ForEach(Self.keys, id: \.0) { key in cap(Text(key.0), key.2) { send(key.1) } }
          cap(Image(systemName: "textformat.size.smaller"), "Smaller text") { fontSize = max(8, fontSize - 1) }
          cap(Image(systemName: "textformat.size.larger"), "Larger text") { fontSize = min(18, fontSize + 1) }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 8)
      }
    }
    .background(look.panel)
  }

  /// one key; an armed Ctrl or ⌘ stands in the accent until the key it goes with
  private func cap(_ face: some View, _ name: String, on: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      face.font(.system(size: 15, weight: .medium, design: .monospaced)).frame(minWidth: 34, minHeight: 34).padding(.horizontal, 6)
        .background(on ? look.accent : look.raised, in: RoundedRectangle(cornerRadius: 8))
        .foregroundStyle(on ? look.ground : look.text)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityIdentifier("key-\(name)")
  }
}
#endif
