#if os(iOS)
import KunaCore
import SwiftUI

/// A run of text in one style (`MdSpan` in src/shared/mdblocks.ts).
struct MdSpan: Decodable, Hashable {
  var t: String
  var b: Bool?
  var i: Bool?
  var c: Bool?
  var s: Bool?
  var m: Bool?
  var href: String?
}

/// One block of a reply (`MdBlock` in src/shared/mdblocks.ts): the blocks come flat, each saying
/// how deep in lists and quotes it is.
struct MdBlock: Decodable, Hashable {
  var kind: String
  var depth: Int
  var quote: Int
  var mark: String?
  var spans: [MdSpan]?
  var level: Int?
  var text: String?
  var lang: String?
  var align: [String?]?
  var head: [[MdSpan]]?
  var rows: [[[MdSpan]]]?
}

/// An agent's reply as it is written: paragraphs, headings, lists in lists, tasks, quotes, code,
/// tables and math. The Markdown is read by the same library as on the Mac (`markdownBlocks`);
/// this only draws the blocks.
struct MarkdownText: View {
  let blocks: [MdBlock]
  @Environment(\.look) private var look

  /// replies read once: a conversation's rows are made again with every change
  @MainActor private static var read: [String: [MdBlock]] = [:]

  @MainActor
  init(_ text: String) {
    if let hit = Self.read[text] {
      blocks = hit
    } else {
      // what cannot be read is shown as it was written
      blocks = (try? Shared.main.decode([MdBlock].self, "markdown", [text])) ?? [MdBlock(kind: "p", depth: 0, quote: 0, spans: [MdSpan(t: text)])]
      if Self.read.count > 600 { Self.read.removeAll() }
      Self.read[text] = blocks
    }
  }

  private static let step: CGFloat = 20

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          if let mark = block.mark {
            Text(mark).foregroundStyle(look.accent).monospacedDigit().fixedSize().frame(minWidth: Self.step, alignment: .leading).padding(.trailing, mark.count > 2 ? 4 : 0)
          }
          one(block).frame(maxWidth: .infinity, alignment: .leading)
        }
        // a list item's mark sits in the indent of its own level
        .padding(.leading, CGFloat(max(0, block.depth - (block.mark == nil ? 0 : 1))) * Self.step + CGFloat(block.quote) * 13)
        .overlay(alignment: .leading) {
          HStack(spacing: 10) {
            ForEach(0..<block.quote, id: \.self) { _ in Rectangle().fill(look.line).frame(width: 3) }
          }
          // one bar down a quote of several blocks
          .padding(.vertical, -5)
        }
      }
    }
    .foregroundStyle(look.text)
    .tint(look.accent)
  }

  @ViewBuilder
  private func one(_ block: MdBlock) -> some View {
    switch block.kind {
    case "h":
      let level = block.level ?? 3
      // the reply's skeleton stands out: its large headings in the accent, the small ones bright
      Text(styled(block.spans)).font(level <= 1 ? .title3.weight(.bold) : level == 2 ? .headline : .subheadline.weight(.semibold))
        .foregroundStyle(level <= 2 ? look.accent : look.bright).padding(.top, 4)
    case "code":
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text(block.lang ?? "").font(.caption2.monospaced()).foregroundStyle(look.dim)
          Spacer()
          // code is there to be run: one tap takes the block
          CopyButton(text: block.text ?? "", label: "Copy the code").accessibilityIdentifier("copy-code")
        }
        .padding(.leading, 10).padding(.trailing, 4).padding(.top, 3)
        ScrollView(.horizontal, showsIndicators: false) {
          Text(block.text ?? "").font(.system(size: 12.5, design: .monospaced)).foregroundStyle(look.text).textSelection(.enabled).padding(.horizontal, 10).padding(.bottom, 10)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(look.raised, in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(look.line))
    case "math":
      Text(block.text ?? "").font(.system(.body, design: .serif)).italic().frame(maxWidth: .infinity).padding(.vertical, 2)
    case "rule": Divider().overlay(look.line)
    case "table": table(block)
    default: Text(styled(block.spans)).foregroundStyle(block.quote > 0 ? look.dim : look.text)
    }
  }

  /// A table as a table: its header on a raised row, lines between the rows; one too wide for the screen scrolls sideways.
  private func table(_ block: MdBlock) -> some View {
    let rows = block.rows ?? []
    let head = block.head ?? []
    // a column of short cells is as wide as its text; one with prose in it wraps
    let long = head.indices.map { column in ([head] + rows).contains { $0.indices.contains(column) && $0[column].reduce(0) { $0 + $1.t.count } > 34 } }
    func cell(_ spans: [MdSpan], _ column: Int, bold: Bool) -> some View {
      let how = (block.align ?? [])[safe: column] ?? nil
      let align: Alignment = how == "right" ? .trailing : how == "center" ? .center : .leading
      return Text(styled(spans)).font(bold ? .footnote.weight(.semibold) : .footnote).foregroundStyle(bold ? look.bright : look.text)
        .frame(width: long[safe: column] == true ? 230 : nil, alignment: align)
        .fixedSize(horizontal: long[safe: column] != true, vertical: true)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .gridColumnAlignment(align == .trailing ? .trailing : align == .center ? .center : .leading)
    }
    return ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow { ForEach(Array(head.enumerated()), id: \.offset) { column, spans in cell(spans, column, bold: true) } }.background(look.raised)
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Divider().overlay(look.line).gridCellUnsizedAxes(.horizontal)
          GridRow { ForEach(Array(row.enumerated()), id: \.offset) { column, spans in cell(spans, column, bold: false) } }
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(look.line))
    }
  }

  /// Runs of bold, italics, `code`, struck text, math and links as one text.
  private func styled(_ spans: [MdSpan]?) -> AttributedString {
    var out = AttributedString()
    for span in spans ?? [] {
      var piece = AttributedString(span.t)
      var intent: InlinePresentationIntent = []
      if span.b == true {
        intent.insert(.stronglyEmphasized)
        piece.foregroundColor = look.bright
      }
      if span.i == true || span.m == true { intent.insert(.emphasized) }
      if span.s == true { intent.insert(.strikethrough) }
      if span.c == true {
        intent.insert(.code)
        piece.foregroundColor = look.code
        piece.backgroundColor = look.raised
      }
      if !intent.isEmpty { piece.inlinePresentationIntent = intent }
      if let href = span.href, let url = URL(string: href) {
        piece.link = url
        piece.underlineStyle = .single
      }
      out += piece
    }
    return out
  }
}

extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
#endif
