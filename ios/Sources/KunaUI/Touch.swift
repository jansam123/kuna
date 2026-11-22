#if os(iOS)
import SwiftUI
import UIKit

/// The taps the phone gives. Which one goes with which moment is chosen in Settings, where each can be tried.
enum Haptic: String, CaseIterable, Identifiable {
  case none, tick, light, medium, heavy, soft, rigid, tink, tunk, tunkTunk, softTwice, knock, success, warning

  var id: String { rawValue }

  var name: String {
    switch self {
    case .none: "None"
    case .tick: "Tick"
    case .light: "Light"
    case .medium: "Medium"
    case .heavy: "Heavy"
    case .soft: "Soft"
    case .rigid: "Rigid"
    case .tink: "Tink"
    case .tunk: "Tunk"
    case .tunkTunk: "Tunk-tunk"
    case .softTwice: "Soft twice"
    case .knock: "Knock, three"
    case .success: "Success"
    case .warning: "Warning"
    }
  }

  @MainActor
  func play() {
    func hit(_ style: UIImpactFeedbackGenerator.FeedbackStyle, _ strength: CGFloat = 1, after: Double = 0) {
      DispatchQueue.main.asyncAfter(deadline: .now() + after) { UIImpactFeedbackGenerator(style: style).impactOccurred(intensity: strength) }
    }
    switch self {
    case .none: break
    case .tick: UISelectionFeedbackGenerator().selectionChanged()
    case .light: hit(.light)
    case .medium: hit(.medium)
    case .heavy: hit(.heavy)
    case .soft: hit(.soft)
    case .rigid: hit(.rigid)
    case .tink: hit(.rigid, 0.55)
    case .tunk: hit(.heavy, 0.9)
    case .tunkTunk:
      hit(.heavy)
      hit(.heavy, 0.75, after: 0.13)
    case .softTwice:
      hit(.soft)
      hit(.soft, after: 0.12)
    case .knock:
      hit(.rigid, 0.7)
      hit(.rigid, 0.7, after: 0.09)
      hit(.rigid, 0.9, after: 0.18)
    case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
    case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
  }

  /// A moment the phone answers with a tap, and the tap it has until another is chosen.
  enum Moment: String {
    case opened = "hapticOpen", sent = "hapticSend"
    var usual: Haptic { self == .opened ? .tunkTunk : .tink }
  }

  @MainActor
  static func play(_ moment: Moment) {
    let saved = UserDefaults.standard
    guard saved.object(forKey: "haptics") as? Bool ?? true else { return }
    (saved.string(forKey: moment.rawValue).flatMap(Haptic.init) ?? moment.usual).play()
  }
}

/// UIKit's text view: text that is selected by the word and the line (SwiftUI's own text is taken
/// whole or not at all), and written without the phone's curly quotes, long dashes and capitals.
struct TextArea: UIViewRepresentable {
  /// the view itself, for a button that brings the keyboard up and down
  final class Handle {
    weak var view: UITextView?
    @MainActor func toggleKeyboard() {
      guard let view else { return }
      if view.isFirstResponder { view.resignFirstResponder() } else { view.becomeFirstResponder() }
    }
  }

  @Binding var text: String
  var editable = false
  var mono = true
  var handle: Handle?
  @Environment(\.look) private var look

  func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = editable
    view.backgroundColor = .clear
    view.textColor = UIColor(look.text)
    view.tintColor = UIColor(look.accent)
    view.font = mono ? .monospacedSystemFont(ofSize: 13, weight: .regular) : .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = !mono
    view.autocorrectionType = .no
    view.autocapitalizationType = .none
    view.spellCheckingType = .no
    view.smartQuotesType = .no
    view.smartDashesType = .no
    view.smartInsertDeleteType = .no
    view.keyboardDismissMode = .interactive
    view.alwaysBounceVertical = true
    view.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
    view.delegate = context.coordinator
    view.text = text
    handle?.view = view
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    if view.text != text { view.text = text }
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    @Binding var text: String
    init(text: Binding<String>) { _text = text }
    func textViewDidChange(_ view: UITextView) { text = view.text }
  }
}

/// A text to select from: a reply, or what you wrote.
struct SelectSheet: View {
  let text: String
  @Environment(\.look) private var look
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      TextArea(text: .constant(text), mono: false)
        .background(look.ground)
        .navigationTitle("Select text")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Copy all", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } }
          ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }
    .preferredColorScheme(.dark)
  }
}

/// A button that copies, and shows for a moment that it did.
struct CopyButton: View {
  let text: String
  var label = "Copy"
  @State private var done = false
  @Environment(\.look) private var look

  var body: some View {
    Button(label, systemImage: done ? "checkmark" : "doc.on.doc") {
      UIPasteboard.general.string = text
      done = true
      Task {
        try? await Task.sleep(for: .seconds(1.4))
        done = false
      }
    }
    .labelStyle(.iconOnly).font(.caption).foregroundStyle(done ? look.green : look.dim).buttonStyle(.plain)
    .frame(minWidth: 30, minHeight: 26).contentShape(Rectangle())
  }
}

extension View {
  /// A viewer in place of the screen it was opened from, not over the whole app: the tabs stay
  /// within reach, and it is still open on coming back from another tab.
  func inPlace<Item: Identifiable>(_ item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> some View) -> some View {
    ZStack {
      self.accessibilityHidden(item.wrappedValue != nil)
      if let shown = item.wrappedValue { content(shown).id(shown.id) }
    }
    .toolbar(item.wrappedValue == nil ? .automatic : .hidden, for: .navigationBar)
  }

  /// Over the keyboard of a form: the button that puts it away.
  func keyboardButton() -> some View {
    toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Hide the keyboard", systemImage: "keyboard.chevron.compact.down") { hideKeyboard() }
      }
    }
  }
}
#endif
