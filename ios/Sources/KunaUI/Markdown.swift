#if os(iOS)
import SwiftUI

/// An agent's reply as it is written: paragraphs, headings, lists, code and tables. Not a whole
/// Markdown engine; what it does not know stays as plain text, never dropped.
struct MarkdownText: View {
  let blocks: [Block]
  @Environment(\.look) private var look

  enum Block: Hashable {
    case paragraph(String)
    case heading(Int, String)
    case item(String, String, Int)
    case code(String)
    case rule
  }

  init(_ text: String) { blocks = Self.parse(text) }

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text): Text(Self.inline(text)).frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let text):
          Text(Self.inline(text)).font(level <= 1 ? .title3.weight(.bold) : level == 2 ? .headline : .subheadline.weight(.semibold)).padding(.top, 4)
        case .item(let mark, let text, let depth):
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(mark).foregroundStyle(look.dim).monospacedDigit()
            Text(Self.inline(text)).frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.leading, CGFloat(depth) * 16)
        case .code(let code):
          ScrollView(.horizontal, showsIndicators: false) {
            Text(code).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(look.text).padding(10)
          }
          .background(look.raised, in: RoundedRectangle(cornerRadius: 9))
        case .rule: Divider().overlay(look.line)
        }
      }
    }
    .foregroundStyle(look.text)
    .tint(look.accent)
  }

  /// Bold, italics, `code` and links inside a line.
  static func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(text)
  }

  static func parse(_ text: String) -> [Block] {
    var out: [Block] = []
    var paragraph: [String] = []
    var code: [String]?
    var table: [String] = []
    func flush() {
      if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
      if !table.isEmpty { out.append(.code(table.joined(separator: "\n"))) }
      table = []
    }
    for line in text.components(separatedBy: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        if let open = code {
          out.append(.code(open.joined(separator: "\n")))
          code = nil
        } else {
          flush()
          code = []
        }
        continue
      }
      if code != nil {
        code?.append(line)
        continue
      }
      if trimmed.isEmpty {
        flush()
      } else if trimmed.hasPrefix("|") {
        if !paragraph.isEmpty { flush() }
        table.append(trimmed)
      } else if let m = trimmed.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
        flush()
        out.append(.heading(trimmed[m].filter { $0 == "#" }.count, String(trimmed[m.upperBound...])))
      } else if trimmed.range(of: #"^(-{3,}|\*{3,}|_{3,})$"#, options: .regularExpression) != nil {
        flush()
        out.append(.rule)
      } else if let m = trimmed.range(of: #"^([-*+•]|\d+[.)])\s+"#, options: .regularExpression) {
        flush()
        let mark = trimmed[m].trimmingCharacters(in: .whitespaces)
        let depth = min(4, line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2)
        out.append(.item(mark.first?.isNumber == true ? mark : "•", String(trimmed[m.upperBound...]), depth))
      } else {
        if !table.isEmpty { flush() }
        paragraph.append(trimmed)
      }
    }
    if let open = code { out.append(.code(open.joined(separator: "\n"))) }
    flush()
    return out
  }
}
#endif
