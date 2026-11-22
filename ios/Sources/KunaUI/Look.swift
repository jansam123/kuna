#if os(iOS)
import KunaCore
import SwiftUI

/// The colour scheme in use, as SwiftUI colours (`Theme` in src/shared/themes.ts).
struct Look: Equatable {
  var ground, panel, raised, line, text, dim, faint, accent, insert: Color
  var working, waiting, idle, exited, unread, danger: Color
  /// the scheme's terminal palette, so a colour in a conversation means what it means in the terminal
  var green, blue, magenta, cyan, code, bright: Color

  init(_ t: Theme) {
    ground = Color(hex: t.ground)
    panel = Color(hex: t.panel)
    raised = Color(hex: t.raised)
    line = Color(hex: t.line)
    text = Color(hex: t.text)
    dim = Color(hex: t.dim)
    faint = Color(hex: t.faint)
    accent = Color(hex: t.accent)
    insert = Color(hex: t.insert)
    working = Color(hex: t.working)
    waiting = Color(hex: t.waiting)
    idle = Color(hex: t.idle)
    exited = Color(hex: t.exited)
    unread = Color(hex: t.unread)
    danger = Color(hex: t.danger)
    green = Color(hex: t.terminal["green"] ?? "#4ade80")
    blue = Color(hex: t.terminal["blue"] ?? "#60a5fa")
    magenta = Color(hex: t.terminal["magenta"] ?? "#c084fc")
    cyan = Color(hex: t.terminal["cyan"] ?? "#22d3ee")
    code = Color(hex: t.terminal["brightBlue"] ?? "#93c5fd")
    bright = Color(hex: t.terminal["brightWhite"] ?? "#ffffff")
  }

  /// As on the Mac: blue working, amber needs you, grey idle, red failed, dark stopped.
  func status(_ status: String) -> Color {
    switch status {
    case "working", "starting", "background": working
    case "waiting": waiting
    case "failed": danger
    case "exited": exited
    default: idle
    }
  }
}

extension Color {
  /// `#rgb`, `#rrggbb` or `#rrggbbaa`
  init(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    var v: UInt64 = 0
    Scanner(string: s).scanHexInt64(&v)
    if s.count == 8 {
      self.init(.sRGB, red: Double((v >> 24) & 0xff) / 255, green: Double((v >> 16) & 0xff) / 255, blue: Double((v >> 8) & 0xff) / 255, opacity: Double(v & 0xff) / 255)
    } else {
      self.init(.sRGB, red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255, opacity: 1)
    }
  }
}

extension UIColor {
  convenience init(hex: String) { self.init(Color(hex: hex)) }
}

private struct LookKey: EnvironmentKey {
  static let defaultValue = Look(.fallback)
}

extension EnvironmentValues {
  var look: Look {
    get { self[LookKey.self] }
    set { self[LookKey.self] = newValue }
  }
}

/// As on the Mac: filled for working, needs you, idle and failed; a ring for stopped and for waiting on a job.
struct StatusDot: View {
  let status: String
  var size: CGFloat = 9
  @Environment(\.look) private var look

  var body: some View {
    let color = look.status(status)
    Group {
      if status == "exited" || status == "background" || status == "unknown" {
        Circle().strokeBorder(color, lineWidth: 2)
      } else {
        Circle().fill(color)
      }
    }
    .frame(width: size, height: size)
    .opacity(status == "starting" ? 0.6 : 1)
    .accessibilityHidden(true)
  }
}

/// The word for a status, as the Mac's sidebar says it.
func statusWord(_ agent: Agent) -> String {
  switch agent.status {
  case "waiting": "needs you"
  case "background": "waiting on a job"
  case "exited": agent.isBackground ? "stopped" : "exited"
  case "unknown": "—"
  default: agent.status
  }
}

/// "3m", "2h", "5d": how long ago, in the fewest letters.
func ago(_ epoch: Double) -> String {
  guard epoch > 0 else { return "" }
  let d = max(0, Int(Date().timeIntervalSince1970 - epoch))
  if d < 60 { return "now" }
  if d < 3600 { return "\(d / 60)m" }
  if d < 86400 { return "\(d / 3600)h" }
  return "\(d / 86400)d"
}

/// Put the keyboard away, whichever field has it.
@MainActor
func hideKeyboard() {
  UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

func sizeText(_ bytes: Double) -> String {
  if bytes < 1024 { return "\(Int(bytes)) B" }
  if bytes < 1024 * 1024 { return "\(Int(bytes / 1024)) KB" }
  return String(format: "%.1f MB", bytes / 1024 / 1024)
}

extension View {
  /// No autocorrection or capitals: host names, paths and commands are not prose.
  func plain() -> some View {
    autocorrectionDisabled().textInputAutocapitalization(.never)
  }

  /// A card on the ground colour, as panels on the Mac.
  func card(_ look: Look, padding: CGFloat = 14) -> some View {
    self.padding(padding).background(look.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
  }
}
#endif
