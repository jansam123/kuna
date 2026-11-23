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

/// Where the terminal is looked at: `away` from its live screen (scrolled back, or its screen held as text to select from).
@MainActor @Observable
final class TerminalPlace {
  var away = false
}

/// SwiftTerm's view. For an agent in tmux it leaves every drag to the history it stands under:
/// its own pans (the mouse, its selection) never begin.
final class LiveTerminal: TerminalView {
  var still = false
  /// the walkthrough (`-kunaStill YES`): a blinking caret is an animation without end, and XCUITest waits for every animation to end before each step
  static let still = UserDefaults.standard.bool(forKey: "kunaStill")

  override func cursorStyleChanged(source: Terminal, newStyle: CursorStyle) {
    guard Self.still else { return super.cursorStyleChanged(source: source, newStyle: newStyle) }
    switch newStyle {
    case .blinkBlock, .steadyBlock: super.cursorStyleChanged(source: source, newStyle: .steadyBlock)
    case .blinkUnderline, .steadyUnderline: super.cursorStyleChanged(source: source, newStyle: .steadyUnderline)
    case .blinkBar, .steadyBar: super.cursorStyleChanged(source: source, newStyle: .steadyBar)
    }
  }

  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    // asked about the pans of the views above it too (the history's): only its own are refused
    if still, recognizer is UIPanGestureRecognizer, recognizer.view === self { return false }
    return super.gestureRecognizerShouldBegin(recognizer)
  }
}

/// An agent's terminal as one page that scrolls: what its pane scrolled past, as text, and under
/// it the live screen. The text scrolls and is selected as text is anywhere on the phone. (tmux
/// keeps the history on the host; scrolled there with the wheel, every step is a round trip.)
/// A long press on the live screen holds it as text too, to select from.
@MainActor
final class TerminalStack: UIView, UITextViewDelegate {
  let back = UITextView(usingTextLayoutManager: false)
  let live: LiveTerminal
  /// the screen is text, to select from, and the live one is hidden
  private(set) var frozen = false
  /// how text looks before its colours
  var base: [NSAttributedString.Key: Any] = [:]
  var moved: (_ away: Bool) -> Void = { _ in }
  var dragged: () -> Void = {}
  /// at the end: stays there as lines come
  private var pinned = true
  /// how tall the text is
  private var height: CGFloat = 0
  /// while frozen: how much of the text is history, and how many lines the screen has
  private var held = 0
  private var screenLines = 0

  init(live: LiveTerminal) {
    self.live = live
    super.init(frame: live.frame)
    clipsToBounds = true
    back.isEditable = false
    back.backgroundColor = .clear
    back.textContainerInset = .zero
    back.textContainer.lineFragmentPadding = 0
    back.layoutManager.allowsNonContiguousLayout = false
    back.contentInsetAdjustmentBehavior = .never
    back.alwaysBounceVertical = true
    back.isScrollEnabled = false
    back.delegate = self
    back.accessibilityIdentifier = "terminal-back"
    addSubview(back)
    addSubview(live)
    // a drag anywhere scrolls, also one that starts on the live screen
    addGestureRecognizer(back.panGestureRecognizer)
  }

  required init?(coder: NSCoder) { fatalError("made in code") }

  private var line: CGFloat { ceil((base[.font] as? UIFont)?.lineHeight ?? 14) }

  private var newline: NSAttributedString { NSAttributedString(string: "\n", attributes: base) }

  private func measure() {
    guard back.textStorage.length > 0 else {
      height = 0
      return
    }
    back.layoutManager.ensureLayout(for: back.textContainer)
    height = ceil(back.layoutManager.usedRect(for: back.textContainer).height)
  }

  /// under the text: room for the live screen; frozen, what the live screen left free under its last line
  private var room: CGFloat { frozen ? max(0, bounds.height - CGFloat(screenLines) * line) : bounds.height }

  private var end: CGFloat { max(0, height + room - bounds.height) }

  private func place() {
    if back.textContainerInset.bottom != room { back.textContainerInset = UIEdgeInsets(top: 0, left: 0, bottom: room, right: 0) }
    back.isScrollEnabled = back.textStorage.length > 0
    if pinned, !back.isTracking, abs(back.contentOffset.y - end) > 0.5 { back.setContentOffset(CGPoint(x: 0, y: end), animated: false) }
    live.isHidden = frozen
    live.frame = CGRect(x: 0, y: height - back.contentOffset.y, width: bounds.width, height: bounds.height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if back.frame != bounds {
      back.frame = bounds
      measure()
    }
    place()
  }

  func scrollViewDidScroll(_ view: UIScrollView) {
    if view.isTracking || view.isDecelerating { pinned = view.contentOffset.y >= end - 4 }
    live.frame.origin.y = height - view.contentOffset.y
    moved(!pinned || frozen)
  }

  func scrollViewWillBeginDragging(_ view: UIScrollView) { dragged() }

  /// Change the history: the first `keep` of it stays, `add` goes after it on a new line. False
  /// when that cannot be (more is to stay than there is): the text is out of step with its source.
  func apply(keep: Int, add: NSAttributedString) -> Bool {
    let storage = back.textStorage
    guard !frozen, keep <= storage.length else { return false }
    guard keep < storage.length || add.length > 0 else { return true }
    storage.beginEditing()
    if keep < storage.length { storage.deleteCharacters(in: NSRange(location: keep, length: storage.length - keep)) }
    if add.length > 0 {
      if storage.length > 0 { storage.append(newline) }
      storage.append(add)
    }
    storage.endEditing()
    measure()
    place()
    return true
  }

  /// The screen as text under the history, in the live screen's place, with the word at `point` selected.
  func freeze(_ screen: NSAttributedString, at point: CGPoint) {
    guard !frozen else { return }
    let storage = back.textStorage
    held = storage.length
    storage.beginEditing()
    if held > 0 { storage.append(newline) }
    storage.append(screen)
    storage.endEditing()
    screenLines = screen.string.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
    frozen = true
    measure()
    place()
    moved(true)
    let right = UITextDirection(rawValue: UITextLayoutDirection.right.rawValue)
    let left = UITextDirection(rawValue: UITextLayoutDirection.left.rawValue)
    guard let at = back.closestPosition(to: convert(point, to: back)) else { return }
    if let word = back.tokenizer.rangeEnclosingPosition(at, with: .word, inDirection: right) ?? back.tokenizer.rangeEnclosingPosition(at, with: .word, inDirection: left) {
      back.becomeFirstResponder()
      back.selectedTextRange = word
      // Copy and the rest, as after a long press on any text (the press here was the live screen's)
      let menu = back.interactions.compactMap { $0 as? UIEditMenuInteraction }.first
      menu?.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: convert(point, to: back)))
    }
  }

  /// Back to the live screen, at the end.
  func toEnd() {
    if frozen {
      back.selectedRange = NSRange(location: 0, length: 0)
      back.resignFirstResponder()
      let storage = back.textStorage
      if held < storage.length { storage.deleteCharacters(in: NSRange(location: held, length: storage.length - held)) }
      frozen = false
    }
    pinned = true
    measure()
    place()
    moved(false)
  }
}

/// An agent's terminal for as long as the agent's screen is open: fed even while it is not
/// shown, so the app can tell what the agent's own screen says.
@MainActor
final class TerminalHolder: NSObject, TerminalViewDelegate, UIGestureRecognizerDelegate {
  private(set) var view: LiveTerminal?
  private(set) var stack: TerminalStack?
  let mods = KeyModifiers()
  let place = TerminalPlace()
  /// the view is being shown what was drawn before it was there
  private var replaying = false
  private let session: AgentSession
  private let reader = ScreenReader()
  private let screen: Terminal
  /// the history's size on the host at the last look, something was drawn since, a look is under way
  private var known = 0
  private var dirty = true
  private var looking = false
  /// the screen at the last look, as text
  private var shown = NSAttributedString()
  private var palette = "{}"
  /// wheel notches are on their way to the agent; those that follow a flick
  private var wheeling = false
  private var glide: Task<Void, Never>?

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
      self?.dirty = true
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

  /// The terminal and its history, made when the terminal is first shown.
  func stack(theme: Theme, fontSize: CGFloat) -> TerminalStack {
    let view = view(theme: theme, fontSize: fontSize)
    let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let lines = NSMutableParagraphStyle()
    // a line of the pane is a line here, as tall as the live screen's, never wrapped a second time
    lines.lineBreakMode = .byClipping
    lines.minimumLineHeight = ceil(font.lineHeight)
    lines.maximumLineHeight = ceil(font.lineHeight)
    let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(hex: theme.terminal["foreground"] ?? "#dfe6f5"), .paragraphStyle: lines]
    palette = (try? JSONSerialization.data(withJSONObject: theme.terminal)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    if let stack {
      stack.base = base
      return stack
    }
    let made = TerminalStack(live: view)
    made.base = base
    made.back.tintColor = UIColor(hex: theme.accent)
    made.moved = { [weak self] away in if self?.place.away != away { self?.place.away = away } }
    made.dragged = { [weak self] in Task { await self?.look() } }
    if session.hasPane {
      view.still = true
      // its own long press and double tap select in a way of their own: the screen is held as text instead
      for old in view.gestureRecognizers ?? [] where type(of: old) == UILongPressGestureRecognizer.self || (old as? UITapGestureRecognizer).map({ $0.numberOfTapsRequired > 1 }) == true { old.isEnabled = false }
      view.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(hold(_:))))
    } else {
      // a background session is drawn by `claude attach`, which keeps the history to itself and scrolls it by the wheel
      let pan = UIPanGestureRecognizer(target: self, action: #selector(wheel(_:)))
      pan.delegate = self
      view.addGestureRecognizer(pan)
    }
    stack = made
    return made
  }

  private func view(theme: Theme, fontSize: CGFloat) -> LiveTerminal {
    if let view {
      apply(theme, fontSize, to: view)
      return view
    }
    let view = LiveTerminal(frame: CGRect(x: 0, y: 0, width: 390, height: 600), font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
    view.terminalDelegate = self
    view.inputAccessoryView = nil
    view.optionAsMetaKey = true
    if LiveTerminal.still { view.cursorStyleChanged(source: view.getTerminal(), newStyle: .steadyBlock) }
    // where the screen's program has the mouse (tmux), a tap is not a click sent to it
    view.allowMouseReporting = false
    apply(theme, fontSize, to: view)
    let drawn = session.drawnSoFar
    if !drawn.isEmpty {
      // what the host asked of the terminal back then was answered then: an answer now would be typed into the agent
      replaying = true
      view.feed(byteArray: ArraySlice(drawn))
      replaying = false
    }
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

  // ------------------------------------------------------------ history ----

  /// Ask the host what the pane scrolled past since the last look, and what it shows now.
  func look() async {
    guard let stack, session.hasPane, dirty, !looking, !stack.frozen else { return }
    looking = true
    defer { looking = false }
    dirty = false
    guard var update = await fetch(from: known) else {
      dirty = true
      return
    }
    // what came does not go on from what is held (much was written since, or the pane has another width): all of it again
    if update.refetch, let whole = await fetch(from: 0) { update = whole }
    guard !update.refetch, stack.apply(keep: update.keep, add: text(update.add, update.styles)) else {
      // out of step with what the shared code holds: both start over at the next look
      try? Shared.main.call("backDrop", [session.key])
      _ = stack.apply(keep: 0, add: NSAttributedString())
      known = 0
      dirty = true
      return
    }
    known = update.size
    shown = text(update.screen, update.styles)
  }

  private func fetch(from: Int) async -> BackUpdate? {
    guard let reply = await session.scrollback(from: from) else { return nil }
    return try? Shared.main.decode(BackUpdate.self, "backFeed", [session.key, reply, palette])
  }

  /// A block of the pane's lines with its colours.
  private func text(_ block: BackBlock, _ styles: [BackStyle]) -> NSAttributedString {
    let base = stack?.base ?? [:]
    let out = NSMutableAttributedString(string: block.text, attributes: base)
    let font = base[.font] as? UIFont ?? .monospacedSystemFont(ofSize: 11, weight: .regular)
    let fore = base[.foregroundColor] as? UIColor ?? .white
    var at = 0
    var i = 0
    while i + 1 < block.runs.count {
      let length = block.runs[i]
      if block.runs[i + 1] < styles.count, at + length <= out.length {
        let style = styles[block.runs[i + 1]]
        var look: [NSAttributedString.Key: Any] = [:]
        if style.fg != nil || style.dim == true { look[.foregroundColor] = (style.fg.map { UIColor(hex: $0) } ?? fore).withAlphaComponent(style.dim == true ? 0.6 : 1) }
        if let bg = style.bg { look[.backgroundColor] = UIColor(hex: bg) }
        if style.bold == true || style.italic == true {
          var traits: UIFontDescriptor.SymbolicTraits = []
          if style.bold == true { traits.insert(.traitBold) }
          if style.italic == true { traits.insert(.traitItalic) }
          if let face = font.fontDescriptor.withSymbolicTraits(traits) { look[.font] = UIFont(descriptor: face, size: font.pointSize) }
        }
        if style.underline == true { look[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if style.strike == true { look[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if !look.isEmpty { out.addAttributes(look, range: NSRange(location: at, length: length)) }
      }
      at += length
      i += 2
    }
    return out
  }

  /// A long press on the live screen: it is held as text, with the word under the finger selected.
  @objc private func hold(_ press: UILongPressGestureRecognizer) {
    guard press.state == .began, let stack, !stack.frozen else { return }
    let point = press.location(in: stack)
    Task {
      dirty = true
      await look()
      guard shown.length > 0, !stack.frozen else { return }
      Haptic.tick.play()
      stack.freeze(shown, at: point)
    }
  }

  // ------------------------------------------------------------ wheel ----

  /// The wheel is for a screen whose program has the mouse; any other scrolls in the terminal view's own way.
  func gestureRecognizerShouldBegin(_ pan: UIGestureRecognizer) -> Bool {
    guard let view else { return false }
    return view.getTerminal().mouseMode != .off && !view.selectionActive
  }

  func gestureRecognizer(_ pan: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

  /// A drag as the mouse wheel: a notch for every line dragged, and after a flick some more, ever slower.
  @objc private func wheel(_ pan: UIPanGestureRecognizer) {
    guard let view else { return }
    let line = ceil(view.font.lineHeight)
    glide?.cancel()
    switch pan.state {
    case .changed:
      let lines = Int(pan.translation(in: view).y / line)
      pan.setTranslation(CGPoint(x: 0, y: pan.translation(in: view).y - CGFloat(lines) * line), in: view)
      notch(lines)
    case .ended:
      // lines a step, thirty steps a second
      var speed = pan.velocity(in: view).y / line / 30
      var rest: CGFloat = 0
      glide = Task {
        while abs(speed) > 0.1, !Task.isCancelled {
          rest += speed
          let lines = Int(rest)
          rest -= CGFloat(lines)
          notch(lines)
          speed *= 0.92
          try? await Task.sleep(for: .milliseconds(33))
        }
      }
    default: break
    }
  }

  /// Wheel notches to the screen's program, in the mouse protocol it asked for: up (earlier lines) for a drag down.
  private func notch(_ lines: Int) {
    guard lines != 0, let terminal = view?.getTerminal(), terminal.mouseMode != .off else { return }
    let button = terminal.encodeButton(button: lines > 0 ? 4 : 5, release: false, shift: false, meta: false, control: false)
    wheeling = true
    for _ in 0..<abs(lines) { terminal.sendEvent(buttonFlags: button, x: terminal.cols / 2, y: terminal.rows / 2) }
    wheeling = false
  }

  /// Back at the live screen.
  func toEnd() {
    stack?.toEnd()
    dirty = true
  }

  /// A key from the keyboard or the key row, with the row's Ctrl or ⌘ when one is armed.
  func key(_ typed: Data) {
    // what is typed goes to the live screen: it is shown again
    if place.away { toEnd() }
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
    dirty = true
  }
  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    // the wheel is no key: it leaves an armed Ctrl or ⌘ for the key that comes
    if wheeling { session.key(Data(data)) } else if !replaying { key(Data(data)) }
  }
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
  let stack: TerminalStack
  func makeUIView(context: Context) -> TerminalStack { stack }
  func updateUIView(_ view: TerminalStack, context: Context) {}
}

/// The agent's own screen in place of its conversation, with the keys a phone keyboard lacks.
struct TerminalScreen: View {
  let model: AppModel
  let session: AgentSession
  let holder: TerminalHolder
  @AppStorage("termFont") private var fontSize = 11.0
  @State private var problem: String?

  var body: some View {
    let stack = holder.stack(theme: model.theme, fontSize: fontSize)
    let view = stack.live
    VStack(spacing: 0) {
      ZStack {
        Color.black
        TerminalPane(stack: stack).padding(.horizontal, 2)
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
      // scrolled back, or holding the screen as text: one tap is back at the live screen
      .overlay(alignment: .bottomTrailing) {
        if holder.place.away {
          Button("Back to the live screen", systemImage: "arrow.down.to.line") { holder.toEnd() }
            .labelStyle(.iconOnly).font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).glassEffect(.regular.interactive(), in: .circle)
            .padding(12).accessibilityIdentifier("terminal-live")
        }
      }
      // how long its context is, slim over the keys
      if let context = model.agent(session.key)?.context ?? session.details?.context {
        HStack { Spacer(); ContextMeter(context: context) }.padding(.horizontal, 10).padding(.top, 4)
      }
      KeyRow(mods: holder.mods, fontSize: $fontSize) {
        if view.isFirstResponder { _ = view.resignFirstResponder() } else {
          holder.toEnd()
          _ = view.becomeFirstResponder()
        }
      } send: {
        holder.key(Data($0.utf8))
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("terminal")
    .task { attach() }
    // its history is asked for while it is looked at, and only when something was drawn since
    .task {
      while !Task.isCancelled {
        await holder.look()
        try? await Task.sleep(for: .seconds(2.5))
      }
    }
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
