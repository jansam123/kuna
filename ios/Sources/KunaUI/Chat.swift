#if os(iOS)
import KunaCore
import SwiftUI

/// What is being written to an agent: one text for its conversation, its plots and its review,
/// as the Mac's prompt is one under all of them.
@MainActor @Observable
final class PromptDraft {
  var text = ""
  /// shown over the plots and the review (the conversation always shows it)
  var shown = false
}

/// The agents whose screens are open: each keeps its conversation and its terminal for as long
/// as it is on the navigation path, also while its plots or its review are on top.
@MainActor
final class OpenAgents {
  struct Open {
    let session: AgentSession
    let terminal: TerminalHolder
    /// review comments written and not yet sent
    let review: ReviewDraft
    let prompt: PromptDraft
  }

  private var open: [String: Open] = [:]
  /// in the order they were last looked at
  private var order: [String] = []

  func get(_ key: String, _ model: AppModel) -> Open {
    if order.last != key {
      order.removeAll { $0 == key }
      order.append(key)
    }
    if let found = open[key] { return found }
    let session = AgentSession(key: key, model: model)
    let made = Open(session: session, terminal: TerminalHolder(session: session), review: ReviewDraft(), prompt: PromptDraft())
    open[key] = made
    return made
  }

  /// The agents on screen keep everything; the last few looked at keep their conversation and
  /// what was being written to them, for swapping back, and only their terminals close.
  func keep(only keys: Set<String>) {
    let recent = Set(order.suffix(6))
    for (key, value) in open where !keys.contains(key) {
      if recent.contains(key) {
        value.session.detach()
      } else {
        value.session.close()
        open[key] = nil
      }
    }
    order.removeAll { open[$0] == nil }
  }
}

/// One agent: its conversation, and under it a box to write to it, which also says what it is doing.
struct AgentScreen: View {
  let model: AppModel
  let key: String
  @Binding var path: [Route]
  let open: OpenAgents
  @Environment(\.look) private var look
  /// its terminal in place of its conversation
  @State private var terminal = false
  @State private var failure: Notice?
  @State private var renaming = false
  @State private var name = ""
  /// a reply or a message opened to select text from
  @State private var selecting: Selecting?
  @FocusState private var typing: Bool
  @State private var atEnd = true

  struct Selecting: Identifiable {
    let id = UUID()
    let text: String
  }

  var body: some View {
    let here = open.get(key, model)
    let session = here.session
    let agent = model.agent(key)
    VStack(spacing: 0) {
      if let agent {
        if terminal {
          TerminalScreen(model: model, session: session, holder: here.terminal)
        } else {
          conversation(agent, here)
        }
      } else {
        ContentUnavailableView("This agent is gone", systemImage: "moon.zzz", description: Text("It is no longer on its host, or its host is not connected."))
      }
    }
    .background(look.ground)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let agent {
        ToolbarItem(placement: .principal) { switcher(agent) }
        ToolbarItemGroup(placement: .primaryAction) {
          // a terminal of its own has no conversation to go back to
          if agent.shell != true {
            Button(terminal ? "Conversation" : "Terminal", systemImage: terminal ? "text.bubble" : "apple.terminal") {
              hideKeyboard()
              terminal.toggle()
            }
            .accessibilityIdentifier("open-terminal")
          }
          Menu("More", systemImage: "ellipsis") {
            Button("Plots and files", systemImage: "photo.on.rectangle.angled") { path.append(.plots(key)) }
            Button("Review changes", systemImage: "plus.forwardslash.minus") { path.append(.review(key)) }
            Button("Files of its folder", systemImage: "doc.text.magnifyingglass") { path.append(.files(agent.host, agent.base)) }
            if let place = model.place(of: key) {
              Button("New terminal here", systemImage: "apple.terminal") { Task { await startTerminal(model, place.project, place.folder, agent.base, $path, $failure) } }
            }
            Divider()
            Button("Rename", systemImage: "pencil") {
              name = model.name(of: agent)
              renaming = true
            }
            AgentActions(model: model, agent: agent, failure: $failure, gone: { path.removeAll { $0 == .agent(key) } })
          }
          .accessibilityIdentifier("agent-more")
        }
      }
    }
    .alert("Name this agent", isPresented: $renaming) {
      TextField("Name", text: $name)
      Button("Save") { model.rename(key, to: name) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Only on this phone. Empty takes its own title back.")
    }
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
    .sheet(item: $selecting) { SelectSheet(text: $0.text).environment(\.look, look) }
    .task(id: key) { await session.follow() }
    .task(id: key) { await session.watchScreen() }
    // it waits for an answer: its screen is opened, so the question can be read and answered from here
    .task(id: agent?.status == "waiting") {
      if agent?.status == "waiting", agent?.shell != true { try? await session.attach() }
    }
    .onChange(of: agent?.transcriptSize) { Task { await session.pull() } }
    // its conversation is read, or its screen is open: the connection to it stands
    .onChange(of: (session.loaded || session.terminal != nil) && model.links[agent?.host ?? ""]?.ready == true) { _, there in
      if there { Haptic.play(.opened) }
    }
    .onAppear {
      // an agent that is not Claude Code has no conversation to read: its terminal is the agent
      if let agent, !agent.isBackground, agent.sessionId == nil, agent.transcriptPath == nil { terminal = true }
    }
  }

  private func place(_ agent: Agent) -> String {
    let folder = (model.place(of: agent.key)?.folder.name).map(model.plain) ?? agent.cwd.split(separator: "/").last.map(String.init) ?? agent.cwd
    return "\(folder) · \(agent.host)"
  }

  /// The agent's name; a tap lists the other agents, to swap to one without going back home.
  private func switcher(_ agent: Agent) -> some View {
    var seen: Set<String> = [key]
    let others = model.tree.flatMap(\.agents).filter { $0.alive && seen.insert($0.key).inserted }
      .sorted { ($0.status == "waiting" ? 1 : 0, max($0.attnTs, $0.activityTs)) > ($1.status == "waiting" ? 1 : 0, max($1.attnTs, $1.activityTs)) }
    return Menu {
      ForEach(others.prefix(14)) { other in
        Button {
          hideKeyboard()
          if let at = path.lastIndex(of: .agent(key)) { path[at] = .agent(other.key) }
        } label: {
          Label(model.name(of: other), systemImage: other.shell == true ? "apple.terminal" : other.status == "waiting" ? "exclamationmark.bubble" : other.status == "working" ? "ellipsis.bubble" : "bubble")
          Text("\(place(other)) · \(other.status == "waiting" ? "needs you" : statusWord(other))")
        }
      }
    } label: {
      VStack(spacing: 1) {
        HStack(spacing: 4) {
          Text(model.name(of: agent)).font(.subheadline.weight(.semibold)).lineLimit(1)
          if !others.isEmpty { Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(look.faint) }
        }
        Text(place(agent)).font(.caption2).foregroundStyle(look.dim).lineLimit(1)
      }
      .foregroundStyle(look.text)
      // between the back button and the two at the right
      .frame(maxWidth: 190)
    }
    .accessibilityIdentifier("agent-switch")
  }

  /// What the agent said in the turn that ends with row `i`, when one ends there: the text its copy button takes.
  private func reply(endingAt i: Int, in items: [ChatItem], working: Bool) -> String? {
    guard items[i].kind != "user", i == items.count - 1 ? !working : items[i + 1].kind == "user" else { return nil }
    var said: [String] = []
    for item in items[...i].reversed() {
      if item.kind == "user" { break }
      if item.kind == "assistant" { said.insert(item.text, at: 0) }
    }
    return said.isEmpty ? nil : said.joined(separator: "\n\n")
  }

  @ViewBuilder
  private func conversation(_ agent: Agent, _ here: OpenAgents.Open) -> some View {
    let session = here.session
    let items = session.items
    let working = agent.status == "working" || agent.status == "starting"
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if !session.loaded {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
          } else if items.isEmpty, session.outbox.isEmpty {
            Text(agent.transcriptPath == nil ? "Nothing to read yet. Its conversation shows up here once it has started; its terminal shows it as it is." : "No messages yet.")
              .font(.subheadline).foregroundStyle(look.dim).frame(maxWidth: .infinity).padding(.top, 40).padding(.horizontal, 24).multilineTextAlignment(.center)
          }
          ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
            let whole = reply(endingAt: i, in: items, working: working)
            ChatRow(item: item, last: i == items.count - 1 && whole == nil, select: { selecting = Selecting(text: $0) }).id(item.id)
            if let whole { ReplyFoot(text: whole, at: item.at) }
          }
          ForEach(session.outbox) { out in
            ChatRow(item: ChatItem(id: out.id.uuidString, kind: "user", text: out.text), pending: true, select: { selecting = Selecting(text: $0) }).id(out.id.uuidString)
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      // the box floats over the conversation, which scrolls on under its glass
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 8) {
          if let panel = session.panel {
            PanelCard(panel: panel, press: { keys in Task { try? await session.press(keys) } }, terminal: { terminal = true })
          }
          PromptBox(model: model, here: here, typing: $typing, terminal: { terminal = true })
        }
      }
      // at the end, stay at the end as rows come; scrolled up to read, stay where the reader is
      .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.containerSize.height >= $0.contentSize.height - 120 } action: { _, now in atEnd = now }
      .onChange(of: items.last?.id) { if atEnd { proxy.scrollTo("end", anchor: .bottom) } }
      .onChange(of: session.outbox.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
      .onChange(of: session.panel) { if atEnd { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } }
      .onChange(of: typing) { if typing { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } }
    }
  }
}

/// The box a message to the agent is written in, on glass: what the agent is doing and its model
/// above the text, the keyboard's button at its left, send at its right. Typing a slash offers
/// Claude Code's commands. A stopped session is started again by what is sent to it, and a
/// message sent in the middle of a turn is read when the turn is over.
struct PromptBox: View {
  let model: AppModel
  let here: OpenAgents.Open
  var typing: FocusState<Bool>.Binding
  /// opens the agent's terminal; none where there is none to open (over its plots, its review)
  var terminal: (() -> Void)?
  var sent: () -> Void = {}
  @Environment(\.look) private var look
  @State private var sending = false
  @State private var failure: Notice?

  var body: some View {
    @Bindable var draft = here.prompt
    let agent = model.agent(here.session.key)
    let offered = here.session.slash(draft.text)
    VStack(alignment: .leading, spacing: 6) {
      if !offered.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(offered) { command in
            Button { here.prompt.text = command.name + " " } label: {
              HStack(spacing: 10) {
                Text(command.name).font(.subheadline.monospaced()).foregroundStyle(look.accent).lineLimit(1)
                Text(command.about).font(.caption).foregroundStyle(look.dim).lineLimit(1)
                Spacer(minLength: 0)
              }
              .padding(.vertical, 6)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("slash-\(command.name)")
          }
        }
        .padding(.horizontal, 4)
      }
      if let agent {
        StatusLine(agent: agent, details: here.session.details, terminal: terminal, command: { send($0, written: false) }, press: { keys in Task { try? await here.session.press(keys) } })
      }
      HStack(alignment: .bottom, spacing: 8) {
        Button(typing.wrappedValue ? "Hide the keyboard" : "Show the keyboard", systemImage: typing.wrappedValue ? "keyboard.chevron.compact.down" : "keyboard") { typing.wrappedValue.toggle() }
          .labelStyle(.iconOnly).foregroundStyle(look.dim).frame(width: 34, height: 36).accessibilityIdentifier("keyboard")
        TextField(agent?.status == "waiting" ? "It is waiting for you…" : "Message", text: $draft.text, axis: .vertical)
          .lineLimit(1...7).focused(typing).padding(.vertical, 8)
          .accessibilityIdentifier("message")
        Button { send(here.prompt.text, written: true) } label: {
          if sending { ProgressView().frame(width: 34, height: 34) } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 34)) }
        }
        .disabled(sending || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("send")
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: .rect(cornerRadius: 24))
    .padding(.horizontal, 10)
    .padding(.bottom, 8)
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
  }

  /// `written`: what is in the box, which is emptied; otherwise a command from the model's menu.
  private func send(_ text: String, written: Bool) {
    sending = true
    Task {
      do {
        try await here.session.send(text)
        Haptic.play(.sent)
        if written {
          if here.prompt.text == text { here.prompt.text = "" }
          sent()
        }
      } catch {
        failure = Notice(title: "Not sent", text: error.localizedDescription)
      }
      sending = false
    }
  }
}

/// The prompt over an agent's plots or its review: shown and hidden by `PromptButton`, the text
/// stays while it is hidden and is the same one as in the conversation. The keyboard comes up
/// with its own button, not by itself: what is being looked at stays in view.
struct PromptDrawer: View {
  let model: AppModel
  let here: OpenAgents.Open
  @FocusState private var typing: Bool

  var body: some View {
    if here.prompt.shown {
      PromptBox(model: model, here: here, typing: $typing) { here.prompt.shown = false }
    }
  }
}

/// Shows and hides the prompt; filled while something is written in it.
struct PromptButton: View {
  let here: OpenAgents.Open

  var body: some View {
    Button(here.prompt.shown ? "Hide the prompt" : "Write to the agent", systemImage: here.prompt.text.isEmpty ? "square.and.pencil" : "square.and.pencil.circle.fill") {
      if here.prompt.shown { hideKeyboard() }
      here.prompt.shown.toggle()
    }
    .labelStyle(.iconOnly)
    .accessibilityIdentifier("prompt-toggle")
  }
}

/// What the agent is doing right now, its model (a tap changes it, the thinking effort or the
/// mode, as Claude Code's own commands do), and how full its context is.
private struct StatusLine: View {
  let agent: Agent
  let details: ChatDetails?
  var terminal: (() -> Void)?
  /// type one of Claude Code's commands; press keys on its screen
  let command: (String) -> Void
  let press: (String) -> Void
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 8) {
      if agent.status == "working" || agent.status == "starting" { ProgressView().controlSize(.mini) } else { StatusDot(status: agent.status, size: 8) }
      Text(words).font(.footnote).foregroundStyle(agent.status == "waiting" ? look.waiting : look.dim).lineLimit(1)
      Spacer(minLength: 4)
      if agent.status == "waiting", let terminal {
        Button("Terminal", action: terminal).font(.footnote.weight(.semibold)).buttonStyle(.bordered).controlSize(.small).tint(look.waiting).accessibilityIdentifier("answer-terminal")
      }
      if let model = agent.modelName ?? details?.model {
        Menu {
          Button("Model…", systemImage: "cpu") { command("/model") }
          Button("Thinking effort…", systemImage: "brain") { command("/effort") }
          Button("Next mode (⇧Tab)", systemImage: "arrow.triangle.2.circlepath") { press("\u{1b}[Z") }
          if let mode = details?.permissionMode ?? agent.permissionMode { Section("Mode now: \(mode)") {} }
        } label: {
          HStack(spacing: 3) {
            // the model and how hard it thinks (the effort of its last reply), as the Mac's chip
            Text([model, details?.effort].compactMap { $0 }.joined(separator: " · ")).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .bold))
          }
          .font(.footnote).foregroundStyle(look.dim)
        }
        .accessibilityIdentifier("model-menu")
      }
      if let context = agent.context ?? details?.context {
        Text("\(Int(context.pct))%").font(.caption.monospacedDigit()).foregroundStyle(context.level == "ok" ? look.faint : context.level == "full" ? look.danger : look.waiting)
          .accessibilityLabel("Context \(Int(context.pct)) percent full")
      }
    }
    .padding(.horizontal, 6)
    .padding(.top, 2)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityIdentifier("status-line")
  }

  private var words: String {
    if agent.status == "waiting" { return agent.needs ?? "waiting for you" }
    return agent.doing == agent.status ? statusWord(agent) : agent.doing
  }
}

/// A question or a panel of Claude Code's (a permission, the agent's own question, /model), read
/// off its screen: what it says, and its rows to tap. One question after another shows as the
/// screen brings them.
private struct PanelCard: View {
  let panel: Panel
  let press: (String) -> Void
  let terminal: () -> Void
  @Environment(\.look) fileprivate var look

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(panel.text.enumerated()), id: \.offset) { i, line in
        Text(line).font(i == panel.text.count - 1 ? .subheadline.weight(.semibold) : .footnote).foregroundStyle(i == panel.text.count - 1 ? look.bright : look.dim)
      }
      // as tall as its rows; a long list scrolls
      if panel.options.count > 5 { ScrollView { rows }.frame(maxHeight: 280) } else { rows }
      HStack(spacing: 10) {
        Text(panel.hint.joined(separator: " ")).font(.caption2).foregroundStyle(look.faint).lineLimit(2)
        Spacer(minLength: 0)
        Button("esc") { press("\u{1b}") }.font(.footnote.monospaced()).buttonStyle(.bordered).controlSize(.small).accessibilityLabel("Escape")
        Button("Its terminal", systemImage: "apple.terminal", action: terminal).labelStyle(.iconOnly).buttonStyle(.bordered).controlSize(.small)
      }
    }
    .padding(12)
    .glassEffect(.regular, in: .rect(cornerRadius: 24))
    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(look.waiting.opacity(panel.state == "question" ? 0.55 : 0)))
    .padding(.horizontal, 10)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("panel")
  }
}

extension PanelCard {
  private var rows: some View {
    VStack(spacing: 6) {
      ForEach(Array(panel.options.enumerated()), id: \.offset) { i, option in
        Button { press(option.keys) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(option.label).font(.subheadline.weight(.medium)).foregroundStyle(look.text).multilineTextAlignment(.leading)
            if !option.detail.isEmpty { Text(option.detail).font(.caption).foregroundStyle(look.dim).multilineTextAlignment(.leading) }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12).padding(.vertical, 9)
          .background(look.raised.tint(look.accent, option.current ? 0.22 : 0), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("panel-option-\(i + 1)")
      }
    }
  }
}

/// Under a reply of the agent's, where its turn ends: a button that copies all it said in the
/// turn, when it said it, and a line that sets the turn apart from the next.
private struct ReplyFoot: View {
  let text: String
  let at: Double?
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 8) {
      CopyButton(text: text, label: "Copy the reply").accessibilityIdentifier("copy-reply")
      if let at { Text(clock(at)).font(.caption2.monospacedDigit()).foregroundStyle(look.faint).accessibilityIdentifier("chat-time") }
      Rectangle().fill(look.line.opacity(0.7)).frame(height: 1)
    }
    .padding(.top, -6)
  }
}

/// One row of the conversation. Each colour says one thing, as in the terminal: yours on the
/// accent, what was run or changed by what kind of work it is, green done, red failed, amber
/// a limit or a question for you.
private struct ChatRow: View {
  let item: ChatItem
  var pending = false
  /// the conversation's last row, in a turn that is not over
  var last = false
  /// opens a text to select from
  let select: (String) -> Void
  @Environment(\.look) private var look
  @State private var unfolded = false

  var body: some View {
    let yours = item.kind == "user"
    VStack(alignment: yours ? .trailing : .leading, spacing: 4) {
      row
      // when you wrote, and when the last thing in the conversation was said
      if yours || last, let at = item.at {
        Text(clock(at)).font(.caption2.monospacedDigit()).foregroundStyle(look.faint).padding(.horizontal, yours ? 6 : 0).accessibilityIdentifier("chat-time")
      }
    }
    .frame(maxWidth: .infinity, alignment: yours ? .trailing : .leading)
  }

  @ViewBuilder
  private var row: some View {
    switch item.kind {
    case "user":
      HStack {
        Spacer(minLength: 44)
        Text(item.text).font(item.text.hasPrefix("/") ? .body.monospaced() : .body).foregroundStyle(look.bright).padding(.horizontal, 13).padding(.vertical, 9)
          .background(look.raised.tint(look.accent, 0.3), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
          .opacity(pending ? 0.55 : 1)
          .contextMenu { copying }
      }
      .padding(.top, 6)
    case "assistant":
      MarkdownText(item.text).frame(maxWidth: .infinity, alignment: .leading).contextMenu { copying }
    case "limit": banner("hourglass", "Usage limit", look.waiting)
    case "error": banner("exclamationmark.triangle.fill", "The request failed", look.danger)
    case "thinking":
      VStack(alignment: .leading, spacing: 6) {
        Button { unfolded.toggle() } label: {
          HStack(spacing: 6) {
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(unfolded ? 90 : 0))
            Text("Thinking").font(.footnote.weight(.medium))
            if !unfolded { Text(item.text.prefix(80).replacingOccurrences(of: "\n", with: " ")).font(.footnote).italic().lineLimit(1).opacity(0.7) }
          }
          .foregroundStyle(look.dim)
        }
        .buttonStyle(.plain)
        if unfolded {
          Text(item.text).font(.footnote).italic().foregroundStyle(look.dim).textSelection(.enabled).padding(.leading, 12)
            .overlay(alignment: .leading) { Rectangle().fill(look.line).frame(width: 2) }
        }
      }
    case "tool":
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        Group {
          switch item.state {
          case "error": Image(systemName: "xmark").foregroundStyle(look.danger)
          case "done": Image(systemName: "checkmark").foregroundStyle(look.green)
          default: Image(systemName: "circle.dotted").foregroundStyle(look.working)
          }
        }
        .font(.caption2.weight(.bold)).frame(width: 12)
        Text(item.tool ?? "tool").font(.system(size: 12.5, weight: .semibold, design: .monospaced)).foregroundStyle(item.state == "error" ? look.danger : work)
        Text(item.text).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(item.state == "error" ? look.danger.opacity(0.85) : look.dim).lineLimit(1).truncationMode(.middle)
      }
      .accessibilityElement(children: .combine)
    case "question":
      VStack(alignment: .leading, spacing: 9) {
        Label(item.tool == "Plan" ? "It proposes a plan" : "It asks", systemImage: item.tool == "Plan" ? "list.bullet.clipboard" : "questionmark.bubble")
          .font(.footnote.weight(.semibold)).foregroundStyle(item.state == "running" ? look.waiting : look.dim)
        MarkdownText(item.text)
        ForEach(Array((item.options ?? []).enumerated()), id: \.offset) { i, option in
          Text(item.state == "running" ? "\(i + 1). \(option)" : option).font(.subheadline).foregroundStyle(item.state == "running" ? look.text : look.green)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(look.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(item.state == "running" ? look.waiting.opacity(0.6) : look.line))
    default:
      HStack(spacing: 10) {
        Rectangle().fill(look.line).frame(height: 1)
        Text(item.text).font(.caption).foregroundStyle(look.dim).fixedSize()
        Rectangle().fill(look.line).frame(height: 1)
      }
      .padding(.vertical, 2)
    }
  }

  /// A long press: the whole text copied, or opened to select a part of it.
  @ViewBuilder
  private var copying: some View {
    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text }
    Button("Select text", systemImage: "selection.pin.in.out") { select(item.text) }
  }

  /// What Claude Code says in the agent's place, in the colour of what it means for you.
  private func banner(_ symbol: String, _ title: String, _ color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(color)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(color)
        Text(item.text).font(.subheadline).foregroundStyle(look.text).textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(look.panel.tint(color, 0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(color.opacity(0.55)))
    .accessibilityIdentifier("chat-\(item.kind)")
  }

  /// a tool's name in the colour of its kind of work: green changes files, magenta runs a command, cyan hands work on, blue looks something up
  private var work: Color {
    switch item.tool ?? "" {
    case "Edit", "Write", "MultiEdit", "NotebookEdit": look.green
    case "Bash", "BashOutput", "KillShell": look.magenta
    case "Task", "Agent", "Workflow", "Skill": look.cyan
    case "Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch": look.blue
    default: look.text
    }
  }
}
#endif
